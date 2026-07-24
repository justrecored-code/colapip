// ============================================================================
// Plugin Manager — registration, validation, lifecycle, task dispatch, recovery
// ============================================================================

import fs from "fs-extra";
import path from "path";
import { PLUGINS_DIR, SKILLS_DIR, ROOT, loadConfig, type PlatformConfig } from "./config.js";
import {
  createTask, updateTaskState, getPendingAndRunningTasks, getAllTasks, getTaskById,
  createAsset, deleteTask, type TaskRow,
} from "./db.js";
import { eventBus } from "./event-bus.js";
import { logger } from "./logger.js";
import { getPlatformLLM, createAdapter, type LLMAdapter } from "./llm.js";
import { ERR_SERVICE_DOWN, ERR_CONTEXT_LIMIT, ERR_UNKNOWN } from "./error-codes.js";
import type { Plugin, PluginConfig, PluginContext, Task, ToolDef } from "./plugin.js";

// ============================================================================
// Tool Registry (shared tools)
// ============================================================================

class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private toolMdPath = path.join(SKILLS_DIR, "TOOLS.md");

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool "${tool.name}" already registered, skipping`, "tool-registry");
      return;
    }
    this.tools.set(tool.name, tool);
    logger.info(`Tool registered: ${tool.name}`, "tool-registry");
  }

  get(name: string): ToolDef | null {
    return this.tools.get(name) ?? null;
  }

  getAll(): ToolDef[] {
    return [...this.tools.values()];
  }

  async loadFromDir(): Promise<void> {
    if (!fs.existsSync(SKILLS_DIR)) return;
    for (const file of fs.readdirSync(SKILLS_DIR)) {
      if (!file.endsWith(".js") && !file.endsWith(".ts")) continue;
      if (file === "TOOLS.md") continue;

      // Dynamic import platform tool
      try {
        const importUrl = "file://" + path.join(SKILLS_DIR, file).replace(/\\/g, "/");
        const mod = await import(importUrl);
        // Find the first export that looks like a ToolDef (has name + execute)
        for (const key of Object.keys(mod)) {
          const val = mod[key];
          if (val && typeof val === "object" && val.name && typeof val.execute === "function") {
            this.register(val);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to load platform tool ${file}: ${msg}`, "tool-registry");
      }
    }
  }
}

export const toolRegistry = new ToolRegistry();

// ============================================================================
// Plugin Manager
// ============================================================================

const ALLOWED_MIME_TYPES = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "audio/wav", "audio/mp3", "audio/ogg",
  "video/mp4", "video/webm",
  "text/markdown", "text/plain",
  "application/json", "application/pdf",
];

// Plugin output handlers (set by server.ts during startup)
type PlatformHandler = (data: unknown) => void;
type AgentHandler = (pluginName: string, data: unknown) => void;
let _platformHandler: PlatformHandler | null = null;
let _agentHandler: AgentHandler | null = null;

export function setPluginOutputHandlers(platform: PlatformHandler, agent: AgentHandler): void {
  _platformHandler = platform;
  _agentHandler = agent;
}

/** Direct output for background loops */
export function pluginOutput(): { platform: PlatformHandler | null; agent: AgentHandler | null } {
  return { platform: _platformHandler, agent: _agentHandler };
}

// ============================================================================
// ReplyTo context — stored during Agent calls, injected into task notifications
// ============================================================================

type ReplyTo = { dashboard?: boolean; plugin?: string; pluginData?: unknown };
let _replyToContext: ReplyTo | null = null;

export function getReplyToContext(): ReplyTo | null {
  return _replyToContext;
}

export function setReplyToContext(ctx: ReplyTo | null): void {
  _replyToContext = ctx;
}

// ============================================================================
// Agent Tool Registrar — plugins register their ownSkills as Agent tools
// ============================================================================

type AgentToolRegistrar = (tools: ToolDef[]) => void;
let _agentToolRegistrar: AgentToolRegistrar | null = null;

export function setAgentToolRegistrar(fn: AgentToolRegistrar): void {
  _agentToolRegistrar = fn;
}

class PluginManager {
  private plugins = new Map<string, Plugin>();
  private pluginConfigs = new Map<string, Record<string, unknown>>();
  private _platformLLM: LLMAdapter | null = null;
  private taskAborts = new Map<string, { aborted: boolean }>();

  private get platformLLM(): LLMAdapter {
    if (!this._platformLLM) this._platformLLM = getPlatformLLM();
    return this._platformLLM;
  }

  // ============================================================================
  // Registration
  // ============================================================================

  async scanAndRegister(): Promise<void> {
    if (!fs.existsSync(PLUGINS_DIR)) {
      logger.warn("Plugins directory not found", "plugin-manager");
      return;
    }

    for (const dir of fs.readdirSync(PLUGINS_DIR)) {
      const pluginDir = path.join(PLUGINS_DIR, dir);
      if (!fs.statSync(pluginDir).isDirectory()) continue;

      const configPath = path.join(pluginDir, "plugin.json");
      if (!fs.existsSync(configPath)) {
        logger.warn(`Skipping ${dir}: no plugin.json`, "plugin-manager");
        continue;
      }

      const pconfig = fs.readJSONSync(configPath) as Record<string, unknown>;

      // Validate name uniqueness
      const name = pconfig.name as string;
      if (!name) {
        logger.warn(`Skipping ${dir}: missing "name" in plugin.json`, "plugin-manager");
        continue;
      }
      if (this.plugins.has(name)) {
        logger.warn(`Skipping ${dir}: name "${name}" already registered`, "plugin-manager");
        continue;
      }

      // Validate Pi Agent
      if (!pconfig.usesPiAgent) {
        logger.warn(`Skipping ${name}: must set usesPiAgent: true`, "plugin-manager");
        continue;
      }

      // Validate INPUT.md
      if (!fs.existsSync(path.join(pluginDir, "INPUT.md"))) {
        logger.warn(`Skipping ${name}: missing INPUT.md`, "plugin-manager");
        continue;
      }

      // Validate OUTPUT.md
      const outputPath = path.join(pluginDir, "OUTPUT.md");
      if (!fs.existsSync(outputPath)) {
        logger.warn(`Skipping ${name}: missing OUTPUT.md`, "plugin-manager");
        continue;
      }
      // Basic OUTPUT.md validation: must declare at least one allowed MIME type
      const outputMd = fs.readFileSync(outputPath, "utf-8");
      const hasValidType = ALLOWED_MIME_TYPES.some(t => outputMd.includes(t));
      if (!hasValidType) {
        logger.warn(`Skipping ${name}: OUTPUT.md must declare at least one allowed MIME type`, "plugin-manager");
        continue;
      }

      // Validate skill dependencies
      const skills = (pconfig.skills as string[]) ?? [];
      let skillMissing = false;
      for (const s of skills) {
        if (!toolRegistry.get(s)) {
          logger.warn(`Skipping ${name}: depends on tool "${s}" which is not in registry`, "plugin-manager");
          skillMissing = true;
        }
      }
      if (skillMissing) continue;

      // Dynamic import plugin (Windows needs file:// URL)
      try {
        const indexPath = path.join(pluginDir, "index.ts");
        const importUrl = "file://" + indexPath.replace(/\\/g, "/");
        const mod = await import(importUrl);
        const plugin = (mod.default ?? mod[name]) as Plugin | undefined;
        if (!plugin || typeof plugin.init !== "function") {
          logger.warn(`Skipping ${name}: index.ts must export default Plugin`, "plugin-manager");
          continue;
        }

        const pluginConfig: PluginConfig = { rootDir: pluginDir, platformLLM: this.platformLLM };
        await plugin.init(pluginConfig);
        await plugin.start();

        this.plugins.set(name, plugin);
        this.pluginConfigs.set(name, pconfig);
        eventBus.emit("plugin.registered", { name, version: plugin.version });
        logger.info(`Registered: ${name} v${plugin.version}`, "plugin-manager");

        // Register plugin's ownSkills as Agent tools (submitTask pattern, no import)
        if (_agentToolRegistrar && plugin.ownSkills.length > 0) {
          _agentToolRegistrar(plugin.ownSkills);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to load ${name}: ${msg}`, "plugin-manager");
      }
    }
  }

  // ============================================================================
  // Task dispatch
  // ============================================================================

  private validateInput(pluginName: string, params: Record<string, unknown>): string | null {
    const inputPath = path.join(PLUGINS_DIR, pluginName, "INPUT.md");
    if (!fs.existsSync(inputPath)) return null;
    const md = fs.readFileSync(inputPath, "utf-8");
    const action = (params.action as string) || "";

    // Find action-specific section (### action_name ...), fall back to global params
    const sectionMatch = action
      ? md.match(new RegExp(`###\\s+${action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^#]*`, "i"))
      : null;
    const searchText = sectionMatch?.[0] ?? md;

    const required = [...searchText.matchAll(/- (\w+): \S+ \(必需\)/g)].map(m => m[1]!);
    for (const r of required) {
      const v = params[r];
      if (v === undefined || v === null || v === "") return `缺少必需参数: ${r}（见 INPUT.md${action ? ` → ${action}` : ""}）`;
    }
    return null;
  }

  // Track running tasks per plugin for concurrency control
  private runningCount = new Map<string, number>();

  private getMaxConcurrent(pluginName: string): number {
    const cfg = this.pluginConfigs.get(pluginName);
    return (cfg?.maxConcurrent as number) ?? 1;
  }

  async submitTask(pluginName: string, params: Record<string, unknown>): Promise<string> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not found`);

    const err = this.validateInput(pluginName, params);
    if (err) throw new Error(err);

    if (!("notify" in params)) params.notify = false;

    // If a plugin context is active, auto-inject routing so task completion notifies the right channel
    if (_replyToContext) {
      params.notify = true;
      params._replyTo = _replyToContext;
    }

    const taskId = createTask(pluginName, params);
    logger.info(`Task created: ${taskId} (${pluginName}) params=${JSON.stringify(params).slice(0, 200)}`, "plugin-manager");

    const running = this.runningCount.get(pluginName) ?? 0;
    const max = this.getMaxConcurrent(pluginName);
    if (running >= max) {
      // Queue as pending
      logger.info(`Task ${taskId} queued (${pluginName}: ${running}/${max})`, "plugin-manager");
      return taskId;
    }

    this.dispatchTask(taskId, pluginName, params);
    return taskId;
  }

  private dispatchTask(taskId: string, pluginName: string, params: Record<string, unknown>): void {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return;

    // Merge checkpoint into params so plugins read it via _resumeFrom
    const row = getTaskById(taskId);
    if (row?.checkpoint) {
      try { params = { ...params, _resumeFrom: JSON.parse(row.checkpoint) }; }
      catch { logger.error(`Failed to parse checkpoint for task ${taskId}`, "plugin-manager"); }
    }

    const task: Task = { id: taskId, pluginName, params };
    const ctx = this.buildContext(pluginName, taskId);

    this.runningCount.set(pluginName, (this.runningCount.get(pluginName) ?? 0) + 1);
    updateTaskState(taskId, "running", { error: "" });
    eventBus.emit("task.state_change", { taskId, state: "running" });

    const run = (retry: boolean): void => {
      plugin!.execute(task, ctx).then(result => {
        // User paused/cancelled — state already handled, don't touch it
        if (ctx.aborted) return;
        if (result.success) {
          updateTaskState(taskId, "completed", { progress: 1 });
          eventBus.emit("task.completed", { taskId, data: result.data, pluginName });
          if (params.notify && _agentHandler) {
            logger.info(`Task ${taskId} completed, notifying agent`, "plugin-manager");
            const replyTo = (params._replyTo as ReplyTo) || { dashboard: true };
            _agentHandler("dashboard", { prompt: `[系统] 任务 ${taskId} (${pluginName}) 已完成。${JSON.stringify(result.data || {}).slice(0, 2000)}`, replyTo });
          }
        } else {
          const err = result.error ?? "Unknown error";
          this.handleTaskError(taskId, pluginName, err);
          if (params.notify && _agentHandler && /ERR_SERVICE_DOWN/.test(err)) {
            _agentHandler("dashboard", { prompt: `[系统] 任务 ${taskId} (${pluginName}) 暂停：${err.slice(0, 100)}。恢复后自动重试。`, replyTo: (params._replyTo as ReplyTo) || { dashboard: true } });
          }
        }
      }).catch(err => {
        if (ctx.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        const isContext = /context|CONTEXT|context_length|maximum context/i.test(msg);
        if (isContext && retry) {
          logger.warn(`任务 ${taskId} 上下文超限，自动重试...`, "plugin-manager");
          updateTaskState(taskId, "pending", { error: "" });
          setTimeout(() => { if (this.plugins.has(pluginName)) run(false); }, 1000);
          return;
        }
        this.handleTaskError(taskId, pluginName, msg);
      }).finally(() => {
      this.taskAborts.delete(taskId);
      this.runningCount.set(pluginName, (this.runningCount.get(pluginName) ?? 1) - 1);
      this.dispatchNextPending(pluginName);
    });
    };
    run(true);
  }

  // ============================================================================
  // Unified error handling — single place for error code categorization
  // ============================================================================

  private handleTaskError(taskId: string, pluginName: string, errMsg: string): void {
    const isDown = /ERR_SERVICE_DOWN|service.down|ECONNREFUSED|fetch.failed/i.test(errMsg);
    const isCtx = /context|CONTEXT/i.test(errMsg);
    if (isDown) {
      updateTaskState(taskId, "paused", { error: errMsg });
      eventBus.emit("task.error", { taskId, errorCode: ERR_SERVICE_DOWN, rawError: errMsg, pluginName });
    } else if (isCtx) {
      updateTaskState(taskId, "failed", { error: errMsg });
      eventBus.emit("task.error", { taskId, errorCode: ERR_CONTEXT_LIMIT, rawError: errMsg, pluginName });
    } else {
      updateTaskState(taskId, "failed", { error: errMsg });
      eventBus.emit("task.error", { taskId, errorCode: ERR_UNKNOWN, rawError: errMsg, pluginName });
    }
  }

  private dispatchNextPending(pluginName: string): void {
    const max = this.getMaxConcurrent(pluginName);
    const running = this.runningCount.get(pluginName) ?? 0;
    if (running >= max) return;

    // Find oldest pending task for this plugin
    const pending = getPendingAndRunningTasks()
      .find(t => t.plugin_name === pluginName && t.state === "pending");
    if (pending) {
      let params: Record<string, unknown>;
      try { params = JSON.parse(pending.params || "{}"); } catch { updateTaskState(pending.id, "failed", { error: "params JSON 损坏" }); eventBus.emit("task.error", { taskId: pending.id, errorCode: "ERR_UNKNOWN", rawError: "params JSON 损坏", pluginName }); return; }
      this.dispatchTask(pending.id, pluginName, params);
    }
  }

  // ============================================================================
  // Shared PluginContext factory (used by dispatchTask + recoverTasks)
  // ============================================================================

  private createPluginContext(pluginName: string, taskId: string, opts?: { reuseSessionLog?: boolean; logSuffix?: string }): PluginContext {
    const plugin = this.plugins.get(pluginName);
    if (!this.taskAborts.has(taskId)) this.taskAborts.set(taskId, { aborted: false });
    const sig = this.taskAborts.get(taskId)!;

    // Log setup: session log (reuse within 1hr) or fresh task log (recovery)
    const logDir = path.join(ROOT, "logs", pluginName);
    fs.ensureDirSync(logDir);
    let logPath: string;
    let logFlags: string;

    if (opts?.reuseSessionLog !== false) {
      // Session log: keep last 5, reuse if <1hr old (for long-running plugins)
      const prefix = pluginName + "-";
      const oldLogs = fs.readdirSync(logDir).filter(f => f.startsWith(prefix) && f.endsWith(".log")).sort().reverse();
      for (const f of oldLogs.slice(5)) fs.removeSync(path.join(logDir, f));
      if (oldLogs.length > 0) {
        const latest = path.join(logDir, oldLogs[0]!);
        const age = Date.now() - fs.statSync(latest).mtimeMs;
        logPath = age < 3600_000 ? latest : path.join(logDir, `${pluginName}-${Date.now()}.log`);
      } else {
        logPath = path.join(logDir, `${pluginName}-${Date.now()}.log`);
      }
      logFlags = "a";
    } else {
      // Fresh task log (recovery)
      const suffix = opts?.logSuffix ?? taskId.slice(0, 8);
      logPath = path.join(logDir, `${pluginName}-${suffix}-${Date.now()}.log`);
      logFlags = "w";
    }

    const logStream = fs.createWriteStream(logPath, { flags: logFlags });
    const writeLog = (level: string, msg: string) => {
      const d = new Date();
      const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
      logStream.write(`[${ts}] ${level.toUpperCase()} ${msg}\n`);
    };

    return {
      llm: plugin?.llm ? createAdapter(plugin.llm) : this.platformLLM,
      eventBus: { emit: (event, data) => eventBus.emit(event as any, data) },
      logger: {
        info: (msg) => writeLog("info", msg),
        warn: (msg) => writeLog("warn", msg),
        error: (msg) => writeLog("error", msg),
        debug: (msg) => writeLog("debug", msg),
      },
      createAsset: (tid, type, filePath, filename, size, meta) => {
        createAsset(tid, pluginName, type, filePath, filename, size, meta ?? {});
      },
      get aborted() { return sig.aborted; },
      output: {
        platform: (data) => { if (_platformHandler) _platformHandler(data); },
        agent: (targetOrData: unknown, data?: unknown) => { if (_agentHandler) _agentHandler(data !== undefined ? targetOrData as string : pluginName, data !== undefined ? data : targetOrData); },
      },
    };
  }

  private buildContext(pluginName: string, taskId: string): PluginContext {
    return this.createPluginContext(pluginName, taskId, { reuseSessionLog: true });
  }

  // ============================================================================
  // Task operations
  // ============================================================================

  cancelTask(taskId: string): void {
    updateTaskState(taskId, "cancelled", { error: "user cancelled" });
    eventBus.emit("task.state_change", { taskId, state: "cancelled" });
    // Signal the plugin to stop
    const sig = this.taskAborts.get(taskId);
    if (sig) { sig.aborted = true; logger.info(`Cancellation signal sent to ${taskId}`, "plugin-manager"); }
  }

  pauseTask(taskId: string): void {
    updateTaskState(taskId, "paused");
    eventBus.emit("task.state_change", { taskId, state: "paused" });
    const sig = this.taskAborts.get(taskId);
    if (sig) { sig.aborted = true; logger.info(`Pause signal sent to ${taskId}`, "plugin-manager"); }
  }

  retryTask(taskId: string): void {
    updateTaskState(taskId, "pending", { error: "" });
    eventBus.emit("task.state_change", { taskId, state: "pending" });
    // Reset abort signal so the retried task doesn't immediately abort
    const sig = this.taskAborts.get(taskId);
    if (sig) sig.aborted = false;

    // Trigger dispatch: find the task's plugin and try to run it
    const row = getTaskById(taskId);
    if (row) this.dispatchNextPending(row.plugin_name);
  }

  // ============================================================================
  // Cleanup + Recovery
  // ============================================================================

  /** Delete all tasks belonging to plugins that are no longer registered. */
  cleanupOrphanTasks(): void {
    const knownPlugins = new Set(this.plugins.keys());
    const all = getAllTasks();
    let deleted = 0;
    for (const row of all) {
      if (!knownPlugins.has(row.plugin_name)) {
        deleteTask(row.id);
        deleted++;
      }
    }
    if (deleted > 0) logger.info(`Cleaned up ${deleted} orphan task(s)`, "plugin-manager");
  }

  async recoverTasks(): Promise<void> {
    const tasks = getPendingAndRunningTasks();
    if (tasks.length === 0) return;
    logger.info(`Recovering ${tasks.length} task(s)...`, "plugin-manager");
    for (const row of tasks) {
      const plugin = this.plugins.get(row.plugin_name);
      if (!plugin) { deleteTask(row.id); continue; }
      logger.info(`Resuming task ${row.id} (state: ${row.state}, step: ${row.step || "start"})`, "plugin-manager");
      this.retryTask(row.id);
    }
  }

  // ============================================================================
  // Queries
  // ============================================================================

  getPlugin(name: string): Plugin | null {
    return this.plugins.get(name) ?? null;
  }

  /** Direct action call — no task creation, no queue, instant result. For plugin UI operations. */
  async runDirectAction(pluginName: string, params: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not found`);
    const taskId = "direct-" + Date.now().toString(36);
    const ctx = this.createPluginContext(pluginName, taskId);
    const task: Task = { id: taskId, pluginName, params };
    return await plugin.execute(task, ctx);
  }

  getAllPlugins(): Array<{ name: string; version: string; description: string; status: string; type: string }> {
    return [...this.plugins.values()].map(p => {
      const cfg = this.pluginConfigs.get(p.name) as Record<string, unknown> | undefined;
      return { name: p.name, version: p.version, description: p.description, status: p.getStatus(), type: (cfg?.type as string) || "task" };
    });
  }

  /** Hot-reload a single plugin without restarting the platform */
  async reloadPlugin(name: string): Promise<{ ok: boolean; error?: string }> {
    const old = this.plugins.get(name);
    if (old) {
      try { await old.stop(); } catch { /* ignore */ }
      this.plugins.delete(name);
      this.pluginConfigs.delete(name);
    }

    const pluginDir = path.join(PLUGINS_DIR, name);
    if (!fs.existsSync(pluginDir)) return { ok: false, error: `插件目录不存在: ${pluginDir}` };
    const configPath = path.join(pluginDir, "plugin.json");
    if (!fs.existsSync(configPath)) return { ok: false, error: "缺少 plugin.json" };

    try {
      const pconfig = fs.readJSONSync(configPath) as Record<string, unknown>;
      if (!pconfig.usesPiAgent) return { ok: false, error: "必须声明 usesPiAgent: true" };
      if (!fs.existsSync(path.join(pluginDir, "INPUT.md"))) return { ok: false, error: "缺少 INPUT.md" };
      if (!fs.existsSync(path.join(pluginDir, "OUTPUT.md"))) return { ok: false, error: "缺少 OUTPUT.md" };

      const indexPath = path.join(pluginDir, "index.ts");
      const importUrl = "file://" + indexPath.replace(/\\/g, "/") + "?t=" + Date.now();
      const mod = await import(importUrl);
      const plugin = (mod.default ?? mod[name]) as Plugin | undefined;
      if (!plugin || typeof plugin.init !== "function") return { ok: false, error: "index.ts 必须 export default Plugin" };

      const pluginConfig: PluginConfig = { rootDir: pluginDir, platformLLM: this.platformLLM };
      await plugin.init(pluginConfig);
      await plugin.start();

      this.plugins.set(name, plugin);
      this.pluginConfigs.set(name, pconfig);
      logger.info(`Reloaded: ${name} v${plugin.version}`, "plugin-manager");

      // Re-register plugin tools after reload
      if (_agentToolRegistrar && plugin.ownSkills.length > 0) {
        _agentToolRegistrar(plugin.ownSkills);
      }

      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  async stopAll(): Promise<void> {
    for (const [, plugin] of this.plugins) {
      try { await plugin.stop(); } catch { /* ignore stop errors */ }
    }
    this.plugins.clear();
  }
}

export const pluginManager = new PluginManager();
