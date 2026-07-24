// ============================================================================
// Dashboard Server — Express + WebSocket, serves SPA
// ============================================================================

import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs-extra";
import { fileURLToPath } from "url";
import { loadConfig, ROOT } from "../core/config.js";
import { logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { getPlatformLLM, createAgentModel } from "../core/llm.js";
import { sleep } from "../platform-skills/sleep.js";
import { dbQuery } from "../platform-skills/db_query.js";
import { pluginManager, setPluginOutputHandlers, setAgentToolRegistrar, setReplyToContext, getReplyToContext } from "../core/plugin-manager.js";
import { getAllTasks, getAssets, getChatHistory, saveChatMessage, clearChatHistory, updateTaskState, deleteAsset } from "../core/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

// ============================================================================
// Express + WS
// ============================================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

const logBuffer: { event: string; data: unknown }[] = [];
wss.on("connection", (ws) => {
  clients.add(ws);
  for (const entry of logBuffer) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(entry)); }
  ws.on("close", () => clients.delete(ws));
});
function broadcast(event: string, data: unknown) {
  const msg = { event, data };
  logBuffer.push(msg);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
  const json = JSON.stringify(msg);
  for (const ws of clients) { if (ws.readyState === WebSocket.OPEN) ws.send(json); }
}
eventBus.on("log", (d) => broadcast("log", d));
eventBus.on("task.progress", (d) => {
  broadcast("task.progress", d);
  const data = d as { taskId: string; progress?: number; step?: string };
  if (data.taskId) updateTaskState(data.taskId, "running", { progress: data.progress, step: data.step });
});
eventBus.on("task.error", (d) => broadcast("task.error", d));
eventBus.on("task.completed", (d) => broadcast("task.completed", d));
eventBus.on("task.state_change", (d) => broadcast("task.state_change", d));
eventBus.on("plugin.registered", (d) => broadcast("plugin.registered", d));

app.use(express.json());

// ============================================================================
// Persistent Dashboard Agent (one instance, multi-turn conversation)
// ============================================================================

let dashAgent: Agent | null = null;
const pluginAgents = new Map<string, Agent>();

/** Get or create a plugin-specific Agent instance */
function getPluginAgent(name: string): Agent {
  if (name === "dashboard") return getAgent();
  if (pluginAgents.has(name)) return pluginAgents.get(name)!;
  const agent = new Agent({
    initialState: { systemPrompt: `你是插件 "${name}" 的助手。`, model: dashAgent?.state.model, thinkingLevel: "medium" },
    toolExecution: "sequential",
    getApiKey: async () => "not-needed",
  });
  // Share tools from dashboard agent
  if (dashAgent) {
    agent.state.tools = [...(dashAgent.state.tools || [])];
  }
  pluginAgents.set(name, agent);
  logger.info(`Agent created for plugin: ${name}`, "dashboard");
  return agent;
}

function getAgent(): Agent {
  if (dashAgent) return dashAgent;

  dashAgent = new Agent({
    initialState: {
      systemPrompt: (() => {
        const p = path.join(ROOT, "config", "agent-prompt.md");
        return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "你是平台运维助手。用中文回复。";
      })(),
      model: createAgentModel({ name: "Dashboard" }),
      thinkingLevel: "xhigh",
    },
    toolExecution: "sequential",
    getApiKey: async () => "not-needed",
    transformContext: async (msgs: any[]) => msgs
      .map((m: any) => {
        if (m.role === "assistant" && Array.isArray(m.content)) {
          return { ...m, content: m.content.filter((b: any) => b.type !== "thinking") };
        }
        return m;
      }),
  });

  dashAgent.state.tools = [
    sleep,
    dbQuery,
    { name: "clear_context", label: "清空上下文", description: "清空当前对话历史，保留 system prompt。处理完独立任务后调用",
      parameters: Type.Object({}),
      execute: async () => {
        (dashAgent!.state as any).messages = [];
        return { content: [{ type: "text", text: "上下文已清空" }], details: {} };
      },
    },
    { name: "check_file", label: "检查文件", description: "确认文件路径是否存在",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { path: fp } = raw as { path: string };
        const exists = fs.existsSync(fp);
        return { content: [{ type: "text", text: exists ? `存在: ${fp}` : `不存在: ${fp}` }], details: { exists } };
      },
    },
    { name: "show_image", label: "显示图片", description: "在对话框中显示图片。path 为文件路径，返回可点击查看的链接",
      parameters: Type.Object({ path: Type.String(), label: Type.Optional(Type.String()) }),
      execute: async (_tid: string, raw: unknown) => {
        const { path: fp, label } = raw as { path: string; label?: string };
        if (!fs.existsSync(fp)) return { content: [{ type: "text", text: `图片不存在: ${fp}` }], details: {} };
        const url = `/api/file?path=${encodeURIComponent(fp)}`;
        return { content: [{ type: "text", text: `![${label || fp}](${url})` }], details: { url } };
      },
    },
    { name: "read_file", label: "读取文件", description: "读取 data/ 目录下的文本文件",
      parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
      execute: async (_tid: string, raw: unknown) => {
        const { path: fp, limit } = raw as { path: string; limit?: number };
        const dataRoot = path.join(ROOT, "data");
        const resolved = path.resolve(fp);
        if (!resolved.startsWith(dataRoot)) return { content: [{ type: "text", text: `仅允许读取 data/ 目录: ${fp}` }], details: {} };
        if (!fs.existsSync(resolved)) return { content: [{ type: "text", text: `文件不存在: ${fp}` }], details: {} };
        const text = fs.readFileSync(resolved, "utf-8");
        return { content: [{ type: "text", text: text.slice(0, limit || 5000) }], details: {} };
      },
    },
    { name: "list_dir", label: "列出目录", description: "列出 data/ 目录下的文件和子目录",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { path: fp } = raw as { path: string };
        const dataRoot = path.join(ROOT, "data");
        const resolved = path.resolve(fp);
        if (!resolved.startsWith(dataRoot)) return { content: [{ type: "text", text: `仅允许列出 data/ 目录: ${fp}` }], details: {} };
        if (!fs.existsSync(resolved)) return { content: [{ type: "text", text: `目录不存在: ${fp}` }], details: {} };
        if (!fs.statSync(resolved).isDirectory()) return { content: [{ type: "text", text: `不是目录: ${fp}` }], details: {} };
        const items = fs.readdirSync(resolved).map(name => {
          try { const s = fs.statSync(path.join(resolved, name)); return s.isDirectory() ? `${name}/` : name; }
          catch { return `${name} (不可访问)`; }
        });
        return { content: [{ type: "text", text: items.join("\n") || "(空目录)" }], details: {} };
      },
    },
    { name: "read_platform_doc", label: "读平台文档", description: "读取 README.md",
      parameters: Type.Object({}),
      execute: async () => {
        const readme = path.join(ROOT, "README.md");
        const text = fs.existsSync(readme) ? fs.readFileSync(readme, "utf-8") : "";
        return { content: [{ type: "text", text: text.slice(0, 3000) }], details: {} };
      },
    },
    { name: "list_plugins", label: "列出插件", description: "返回所有已注册插件",
      parameters: Type.Object({}),
      execute: async () => {
        const all = pluginManager.getAllPlugins();
        return { content: [{ type: "text", text: all.map(p => `${p.name}: ${p.description}`).join("\n") || "无" }], details: {} };
      },
    },
    { name: "read_plugin_doc", label: "读插件文档", description: "读 INPUT.md + OUTPUT.md",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { name } = raw as { name: string };
        const d = path.join(ROOT, "plugins", name);
        const i = fs.existsSync(path.join(d, "INPUT.md")) ? fs.readFileSync(path.join(d, "INPUT.md"), "utf-8") : "(无)";
        const o = fs.existsSync(path.join(d, "OUTPUT.md")) ? fs.readFileSync(path.join(d, "OUTPUT.md"), "utf-8") : "(无)";
        return { content: [{ type: "text", text: `INPUT:\n${i}\n\nOUTPUT:\n${o}` }], details: {} };
      },
    },
    { name: "list_tasks", label: "列出任务", description: "查询平台任务",
      parameters: Type.Object({ state: Type.Optional(Type.String()) }),
      execute: async (_tid: string, raw: unknown) => {
        const { state } = raw as { state?: string };
        const tasks = getAllTasks().filter(t => !state || t.state === state).slice(0, 10);
        return { content: [{ type: "text", text: tasks.map(t => `[${t.state}] ${t.id} ${t.plugin_name} ${t.step}`).join("\n") || "无" }], details: {} };
      },
    },
    { name: "pause_task", label: "暂停任务", description: "暂停一个任务",
      parameters: Type.Object({ taskId: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { taskId } = raw as { taskId: string };
        pluginManager.pauseTask(taskId);
        return { content: [{ type: "text", text: `任务 ${taskId} 已暂停` }], details: {} };
      },
    },
    { name: "retry_task", label: "重试任务", description: "重试失败的任务",
      parameters: Type.Object({ taskId: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { taskId } = raw as { taskId: string };
        pluginManager.retryTask(taskId);
        return { content: [{ type: "text", text: `任务 ${taskId} 已重新加入队列` }], details: {} };
      },
    },
    { name: "reload_plugin", label: "重载插件", description: "热重载指定插件，无需重启平台",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_tid: string, raw: unknown) => {
        const { name } = raw as { name: string };
        const result = await pluginManager.reloadPlugin(name);
        return { content: [{ type: "text", text: result.ok ? `${name} 重载成功` : `重载失败: ${result.error}` }], details: {} };
      },
    },
    { name: "submit_task", label: "提交任务",
      description: "提交插件任务。Agent 负责判断用户意图，确认后再调此工具。",
      parameters: Type.Object({ plugin: Type.String(), params: Type.Optional(Type.Object({})) }),
      execute: async (_tid: string, raw: unknown) => {
        const p = raw as { plugin: string; params?: Record<string, unknown> };
        const id = await pluginManager.submitTask(p.plugin, p.params ?? {});
        return { content: [{ type: "text", text: `✅ 已提交: ${id}` }], details: { taskId: id } };
      },
    },
  ];

  return dashAgent;
}

// ============================================================================
// Routes
// ============================================================================

app.get("/api/health", async (_req, res) => {
  const adapter = getPlatformLLM() as any;
  const status = adapter.status ?? "online";
  res.json({ ok: status === "online", llm: status, queue: adapter.queueDepth ?? 0, processing: adapter.isProcessing ?? false });
});

app.get("/api/plugins", (_req, res) => {
  const plugins = pluginManager.getAllPlugins();
  res.json(plugins.map(p => ({
    ...p,
    hasUi: fs.existsSync(path.join(ROOT, "plugins", p.name, "ui.html")),
    hasLog: fs.existsSync(path.join(ROOT, "logs", p.name)),
  })));
});

// Serve plugin custom UI pages
app.get("/plugins/:name/ui", (req, res) => {
  const uiPath = path.join(ROOT, "plugins", req.params.name, "ui.html");
  if (fs.existsSync(uiPath)) res.sendFile(uiPath);
  else res.status(404).send("plugin UI not found");
});

// Parse INPUT.md for a plugin — returns params as [{ name, type, required, desc }]
app.get("/api/plugins/:name/input", (req, res) => {
  const inputPath = path.join(ROOT, "plugins", req.params.name, "INPUT.md");
  if (!fs.existsSync(inputPath)) { res.json([]); return; }
  const md = fs.readFileSync(inputPath, "utf-8");
  const params: Array<{ name: string; type: string; required: boolean; desc: string }> = [];
  for (const m of md.matchAll(/- (\w+): (\S+)(?: \((必需|可选)(?:, 默认: (.+?))?\))?(?: — (.+))?/g)) {
    params.push({
      name: m[1]!,
      type: m[2]!,
      required: m[3] === "必需",
      desc: (m[5] ?? "").trim(),
    });
  }
  res.json(params);
});

app.get("/api/tasks", (_req, res) => {
  res.json(getAllTasks());
});

app.post("/api/tasks/:id/cancel", (req, res) => { pluginManager.cancelTask(req.params.id); res.json({ ok: true }); });
app.post("/api/tasks/:id/pause", (req, res) => { pluginManager.pauseTask(req.params.id); res.json({ ok: true }); });
app.post("/api/tasks/:id/retry", (req, res) => { pluginManager.retryTask(req.params.id); res.json({ ok: true }); });

// Get latest log for a plugin (tail last 128KB max)
app.get("/api/plugins/:name/log", (req, res) => {
  const logDir = path.join(ROOT, "logs", req.params.name);
  if (!fs.existsSync(logDir)) { res.status(404).send("no logs"); return; }
  const logs = fs.readdirSync(logDir).filter(f => f.endsWith(".log")).sort((a, b) => {
    const ta = parseInt(a.match(/-(\d{13})\.log$/)?.[1] || "0");
    const tb = parseInt(b.match(/-(\d{13})\.log$/)?.[1] || "0");
    return tb - ta;
  });
  if (logs.length === 0) { res.status(404).send("no logs"); return; }
  const fp = path.join(logDir, logs[0]!);
  const stat = fs.statSync(fp);
  const tailSize = 128 * 1024;
  if (stat.size <= tailSize) { res.sendFile(fp); return; }
  // Send last 128KB as text
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(tailSize);
  fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
  fs.closeSync(fd);
  res.type("text/plain").send(buf.toString("utf-8"));
});

// Hot-reload a plugin without restarting the platform
app.post("/api/plugins/:name/reload", async (req, res) => {
  const result = await pluginManager.reloadPlugin(req.params.name);
  res.json(result);
});

app.get("/api/chat/history", (_req, res) => { res.json(getChatHistory(100)); });
app.delete("/api/chat/history", (_req, res) => { clearChatHistory(); res.json({ ok: true }); });

app.get("/api/file", (req, res) => {
  const fp = req.query.path as string;
  if (!fp || !fs.existsSync(fp)) { res.status(404).send("not found"); return; }
  res.sendFile(path.resolve(fp));
});

// Direct plugin action — no task creation, instant result (for plugin UI operations)
app.post("/api/plugins/:name/call", async (req, res) => {
  try {
    const result = await pluginManager.runDirectAction(req.params.name, req.body || {});
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

app.get("/api/plugins/available", (_req, res) => {
  res.json(pluginManager.listAvailable());
});

app.post("/api/plugins/install", async (req, res) => {
  const { repo, name } = req.body || {};
  if (!repo || !name) { res.status(400).json({ ok: false, error: "缺少 repo/name" }); return; }
  const result = await pluginManager.installPlugin(repo, name);
  res.json(result);
});

app.get("/api/assets", async (_req, res) => {
  const rows: any[] = [];
  const dataRoot = path.join(ROOT, "data");
  function scan(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      const fp = path.join(dir, e);
      if (fs.statSync(fp).isDirectory()) { scan(fp, prefix + e + "/"); continue; }
      const ext = e.match(/\.(png|jpg|jpeg|webp|gif)$/i) ? `image/${e.split(".").pop()!.toLowerCase()}`
        : e.endsWith(".json") ? "application/json" : e.endsWith(".md") ? "text/markdown" : null;
      if (!ext) continue;
      rows.push({ id: e, task_id: "", plugin_name: "", type: ext, path: fp, filename: prefix + e, size: fs.statSync(fp).size, metadata: "{}", created_at: "" });
    }
  }
  scan(dataRoot, "");
  // Clean up DB: remove entries for files that no longer exist
  const dbAssets = getAssets();
  for (const r of dbAssets) {
    if (!fs.existsSync(r.path)) deleteAsset(r.id);
  }
  const t = _req.query.type as string;
  const filtered = t ? rows.filter(r => r.type.startsWith(t)) : rows;
  res.json(filtered.slice(0, 200));
});

// ============================================================================
// Chat (multi-turn Agent)
// ============================================================================

// ── Agent message queue (shared by Dashboard chat + plugin output.agent) ──
type QueuedItem = { pluginName: string; prompt: string; replyTo: any };
const agentQueue: QueuedItem[] = [];
let queueRunning = false;

function deliverReply(agent: Agent, replyTo: any): void {
  const msgs: any[] = (agent.state as any).messages ?? [];
  const lastMsg = [...msgs].reverse().find((m: any) => m.role === "assistant");
  if (!lastMsg?.content) return;

  if (!replyTo || replyTo.dashboard) {
    saveChatMessage("assistant", JSON.stringify(lastMsg.content));
    broadcast("plugin.output", { type: "agent.reply", blocks: lastMsg.content });
  }

  if (replyTo?.plugin) {
    pluginManager.submitTask(replyTo.plugin, {
      action: "deliver_reply",
      content: lastMsg.content,
      pluginData: replyTo.pluginData,
    }).catch(e => logger.error(`deliverReply 失败: ${(e as Error).message}`, "dashboard"));
  }
}

function runNextQueued(): void {
  if (agentQueue.length === 0) { queueRunning = false; return; }
  queueRunning = true;
  const item = agentQueue.shift()!;
  const agent = item.pluginName === "dashboard" ? getAgent() : (item.pluginName ? getPluginAgent(item.pluginName) : getAgent());
  logger.info(`[agent-handler] ${item.pluginName}: dequeued, prompt len=${item.prompt.length}`, "dashboard");
  const prevContext = getReplyToContext();
  if (item.replyTo) setReplyToContext(item.replyTo);
  Promise.resolve()
    .then(() => agent.prompt(item.prompt))
    .then(() => {
      setReplyToContext(prevContext);
      logger.info(`[agent-handler] ${item.pluginName}: prompt done`, "dashboard");
      deliverReply(agent, item.replyTo);
      runNextQueued();
    })
    .catch((e) => {
      setReplyToContext(prevContext);
      const msg = (e as Error).message;
      logger.error(`[agent-handler] ${item.pluginName}: ${msg}, requeue`, "dashboard");
      agentQueue.unshift(item);
      setTimeout(runNextQueued, 3000);
    });
}

app.post("/api/tasks", async (req, res) => {
  try {
    const { pluginName, params, text } = req.body;

    if (text && !pluginName) {
      saveChatMessage("user", text);
      agentQueue.push({ pluginName: "dashboard", prompt: text, replyTo: { dashboard: true } });
      if (!queueRunning) runNextQueued();
      getPlatformLLM().setStatus("online");
      res.json({ type: "queued" });
      return;
    }

    if (!pluginName) { res.status(400).json({ error: "pluginName required" }); return; }
    const id = await pluginManager.submitTask(pluginName, params ?? {});
    res.json({ taskId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getPlatformLLM().setStatus("offline");
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Static UI
// ============================================================================

const uiDir = path.join(__dirname, "ui");
app.use(express.static(uiDir));
app.get("/", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));

export function startDashboard() {
  // Register plugin tools with Dashboard Agent
  setAgentToolRegistrar((tools) => {
    const agent = getAgent();
    for (const tool of tools) {
      if (!agent.state.tools.some(t => t.name === tool.name)) {
        agent.state.tools.push(tool as any);
        logger.info(`Agent tool registered from plugin: ${tool.name}`, "dashboard");
      }
    }
  });

  setPluginOutputHandlers(
    (data) => broadcast("plugin.output", data),
    (pluginName: string, data: unknown) => {
      const d = data as { prompt?: string; text?: string; replyTo?: { dashboard?: boolean; plugin?: string; pluginData?: unknown } };
      const prompt = d?.prompt || d?.text || JSON.stringify(data);
      const replyTo = d?.replyTo;
      logger.info(`[agent-handler] ${pluginName}: prompt len=${prompt.length} replyTo=${replyTo ? JSON.stringify(replyTo) : "none"}`, "dashboard");
      agentQueue.push({ pluginName, prompt, replyTo });
      if (!queueRunning) runNextQueued();
    },
  );

  // Optimistic: assume LLM is available; first failed chat() will flip to offline
  getPlatformLLM().setStatus("online");

  const { port, host } = config.dashboard;
  server.listen(port, host, () => {
    logger.info(`Dashboard: http://${host}:${port}`, "dashboard");
  });
}
