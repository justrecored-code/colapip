/**
 * LLM Launcher Plugin — 管理本地 LLM 进程：启动、监控、重启
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { loadConfig } from "../../src/core/config.js";
import { ERR_SERVICE_DOWN } from "../../src/core/error-codes.js";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs-extra";
import path from "path";

// ── State ──
let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
let _ctx: PluginContext | null = null;
let _process: ChildProcess | null = null;
let _restartCount = 0;
let _maxRestarts = 10;
let _restartDelay = 5000;

// ── Default command from platform config ──
function defaultCommand(): { cmd: string; args: string[]; cwd?: string } | null {
  const cfgPath = path.join(_rootDir, "config.json");
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = fs.readJSONSync(cfgPath) as { command?: string; args?: string[]; cwd?: string };
  if (!cfg.command) return null;
  return { cmd: cfg.command, args: cfg.args ?? [], cwd: cfg.cwd };
}

function startProcess(cmd: string, args: string[], ctx: PluginContext, cwd?: string): void {
  ctx.logger.info(`启动: ${cmd} ${args.join(" ")}`);
  ctx.output.platform({ type: "llm.status", status: "starting" });

  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: cwd || undefined,
    windowsHide: true,
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) ctx.logger.info(line);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    ctx.logger.warn(line);
    // Detect crash signals
    if (/CUDA error|out of memory|OOM|killed|signal|abort/i.test(line)) {
      ctx.eventBus.emit("task.error", { taskId: "", errorCode: ERR_SERVICE_DOWN, rawError: line, pluginName: "llm-launcher" });
    }
  });

  proc.on("error", (err) => {
    ctx.logger.error(`LLM 进程启动失败: ${err.message}`);
    _status = "error";
    ctx.output.platform({ type: "llm.status", status: "error", error: err.message });
  });

  proc.on("exit", (code, signal) => {
    ctx.logger.info(`LLM 进程退出 code=${code} signal=${signal}`);
    _process = null;
    if (code !== 0 && _status === "running" && _restartCount < _maxRestarts) {
      _restartCount++;
      ctx.logger.info(`自动重启 (${_restartCount}/${_maxRestarts})，${_restartDelay / 1000}s 后重试...`);
      ctx.output.platform({ type: "llm.status", status: "restarting", attempt: _restartCount, max: _maxRestarts });
      setTimeout(() => startProcess(cmd, args, ctx, cwd), _restartDelay);
      _restartDelay = Math.min(_restartDelay * 2, 60000); // exponential backoff up to 60s
    } else if (_status === "running") {
      _status = "error";
      ctx.output.platform({ type: "llm.status", status: "stopped", exitCode: code });
    }
  });

  _process = proc;
  _status = "running";
  _restartDelay = 5000; // reset backoff on successful start
}

function stopProcess(ctx: PluginContext): void {
  if (!_process) return;
  ctx.logger.info("正在停止 LLM 进程...");
  const proc = _process;
  proc.kill("SIGTERM");
  _process = null;
  _status = "idle";
  setTimeout(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  }, 5000);
}

// ── Plugin ──

const llmLauncherPlugin: Plugin = {
  name: "llm-launcher",
  version: "1.0.0",
  description: "本地 LLM 进程管理 — 启动/监控/重启",
  usesPiAgent: true,
  skills: [],
  ownSkills: [],

  async init(config: PluginConfig) {
    _rootDir = config.rootDir;
  },

  async start() { if (!_process) _status = "idle"; },
  async stop() {
    if (_process) stopProcess({ logger: { info() {}, warn() {}, error() {}, debug() {} }, eventBus: { emit() {} }, output: { platform() {}, agent() {} } } as any);
  },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _ctx = ctx;
    const action = (task.params.action as string) || "start";

    if (action === "start") {
      if (_process && _status === "running") return { success: true, data: { status: "already_running" } };

      const def = defaultCommand();
      const cmd = (task.params.command as string) || def?.cmd || "";
      const argsStr = (task.params.args as string) || "";
      const args = argsStr ? argsStr.split(/\s+/) : (def?.args ?? []);
      if (!cmd) return { success: false, error: "缺少 command 参数。提供要启动的 LLM 命令，或编辑 plugins/llm-launcher/config.json" };

      _restartCount = 0;
      startProcess(cmd, args, ctx, def?.cwd);
      // Stay running until stopped or aborted
      while (_status !== "idle" && !ctx.aborted) await new Promise(r => setTimeout(r, 2000));
      if (_process) stopProcess(ctx);
      return { success: true, data: { status: "stopped" } };
    }

    if (action === "stop") {
      stopProcess(ctx);
      _status = "idle";
      return { success: true, data: { status: "stopped" } };
    }

    if (action === "restart") {
      if (_process) stopProcess(ctx);
      await new Promise(r => setTimeout(r, 2000));
      const def2 = defaultCommand();
      const cmd2 = (task.params.command as string) || def2?.cmd || "";
      const args2 = def2?.args ?? [];
      if (!cmd2) return { success: false, error: "缺少 command 参数" };
      _restartCount = 0;
      startProcess(cmd2, args2, ctx, def2?.cwd);
      return { success: true, data: { status: "restarted" } };
    }

    if (action === "status") {
      return { success: true, data: { status: _status, running: !!_process, restarts: _restartCount } };
    }

    return { success: false, error: `未知 action: ${action}` };
  },

};

export default llmLauncherPlugin;
