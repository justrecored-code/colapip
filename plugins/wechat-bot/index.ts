/**
 * WeChat Bot Plugin — 微信个人号消息通道
 *
 * connect: 扫码连接 → 长轮询收消息 → EventBus → Dashboard Agent → 回复
 * 不调 LLM，只做传输。AI 大脑复用 Dashboard Agent。
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT } from "../../src/core/config.js";
import { pluginOutput, pluginManager } from "../../src/core/plugin-manager.js";
import { Type } from "@sinclair/typebox";
import {
  ILINK_BASE_URL,
  fetchQrcode, fetchQrcodeStatus,
  notifyStart, notifyStop,
  getUpdates, sendText, extractText,
  isSessionExpiredError,
  type IlinkSession, type IlinkMessage,
} from "./ilink-client.js";
import { eventBus } from "../../src/core/event-bus.js";
import { ERR_SERVICE_DOWN, ERR_TIMEOUT, ERR_AUTH } from "../../src/core/error-codes.js";
import QRCode from "qrcode";
import fs from "fs-extra";
import path from "path";

// ── State ──

let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
let _ctx: PluginContext | null = null;
let _output: PluginContext["output"] | null = null;

let session: IlinkSession | null = null;
let loopAbort: AbortController | null = null;
let loopRunning = false;
let _aborted = false;

// Fallback logger — works before ctx is available (start() runs before execute())
let _fallbackStream: fs.WriteStream | null = null;
function plog(msg: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  if (_ctx) {
    _ctx.logger.info(msg);
  } else {
    if (!_fallbackStream) {
      const logDir = path.join(ROOT, "logs", "wechat-bot");
      fs.ensureDirSync(logDir);
      _fallbackStream = fs.createWriteStream(path.join(logDir, `wechat-bot-${Date.now()}.log`), { flags: "a" });
    }
    _fallbackStream.write(`[${ts}] INFO ${msg}\n`);
    // Also push to platform log for Dashboard visibility
    eventBus.emit("log", { timestamp: ts, level: "info", plugin: "wechat-bot", message: msg });
  }
}

// ── Contact rules: { contactId: { displayName, mode } } ──
const contactRules = new Map<string, { displayName: string; mode: "auto_reply" | "notify" | "ignore" }>();

// ── Persistence ──

const TOKEN_FILE = "wechat-token.json";
const RULES_FILE = "wechat-rules.json";

function dataDir(): string {
  return _rootDir;
}

function loadToken(): IlinkSession | null {
  try {
    const p = path.join(dataDir(), TOKEN_FILE);
    if (!fs.existsSync(p)) return null;
    return fs.readJSONSync(p) as IlinkSession;
  } catch { return null; }
}

function saveToken(s: IlinkSession): void {
  fs.ensureDirSync(dataDir());
  fs.writeJSONSync(path.join(dataDir(), TOKEN_FILE), s);
}

function clearToken(): void {
  const p = path.join(dataDir(), TOKEN_FILE);
  if (fs.existsSync(p)) fs.removeSync(p);
}

function loadRules(): void {
  try {
    const p = path.join(dataDir(), RULES_FILE);
    if (!fs.existsSync(p)) return;
    const data = fs.readJSONSync(p) as Record<string, { displayName: string; mode: string }>;
    for (const [id, rule] of Object.entries(data)) {
      if (rule.mode === "auto_reply" || rule.mode === "notify" || rule.mode === "ignore") {
        contactRules.set(id, { displayName: rule.displayName, mode: rule.mode });
      }
    }
  } catch { /* ignore */ }
}

function saveRules(): void {
  fs.ensureDirSync(dataDir());
  const data: Record<string, { displayName: string; mode: string }> = {};
  for (const [id, rule] of contactRules) {
    data[id] = rule;
  }
  fs.writeJSONSync(path.join(dataDir(), RULES_FILE), data);
}

// ── Message loop ──

async function runLoop(signal: AbortSignal): Promise<void> {
  if (!session) return;
  let buf = "";

  try { await notifyStart(session); } catch { /* ignore */ }
  if (signal.aborted) return;
  plog("微信长轮询已启动");

  while (loopRunning && !signal.aborted && !_aborted && session) {
    try {
      const s = session;
      const resp = await getUpdates(s, buf, signal);
      if (signal.aborted) break;

      const msgs = resp.msgs ?? [];
      if (resp.get_updates_buf) buf = resp.get_updates_buf;

      for (const msg of msgs) {
        if (signal.aborted) break;
        if (msg.message_type !== 1) continue; // 只处理用户消息

        const from = msg.from_user_id || "";
        const text = extractText(msg);
        if (!from || !text) continue;

        // Check contact rule
        const rule = contactRules.get(from);
        const mode = rule?.mode ?? "notify";

        if (mode === "ignore") continue;

        // New contact → auto-register as notify
        if (!rule) {
          contactRules.set(from, { displayName: from, mode: "notify" });
          saveRules();
        }

        plog(`微信消息 [${mode}] ${from}: ${text.slice(0, 50)}`);

        const out = _output ?? pluginOutput();
        const name = contactRules.get(from)?.displayName || from;
        if (mode === "auto_reply") {
          const promptText = text;
          try {
            out.agent?.("dashboard", { prompt: promptText, replyTo: { plugin: "wechat-bot", pluginData: { to: from, contextToken: msg.context_token || "" } } });
          } catch (e) {
            plog(`转发消息给 Agent 失败: ${(e as Error).message}`);
          }
        } else {
          out.platform?.({ prompt: `[微信通知] ${name}: ${text}` });
        }
      }
    } catch (e) {
      if (signal.aborted) break;
      if (isSessionExpiredError(e)) {
        plog("微信连接已过期，需重新扫码");
        eventBus.emit("task.error", { taskId: "", errorCode: ERR_AUTH, rawError: "session expired", pluginName: "wechat-bot" });
        session = null;
        clearToken();
        loopRunning = false;
        _status = "error";
        pluginOutput().platform?.({ type: "wechat.status", status: "disconnected", error: "session expired" });
        return;
      }
      const eMsg = (e as Error).message;
      const code = eMsg.includes("timeout") || eMsg.includes("AbortError") ? ERR_TIMEOUT : ERR_SERVICE_DOWN;
      eventBus.emit("task.error", { taskId: "", errorCode: code, rawError: eMsg, pluginName: "wechat-bot" });
      plog(`收消息出错，3 秒后重试: ${eMsg}`);
      await sleep(3000);
    }
  }
}

function startLoop(): void {
  if (loopRunning || !session) return;
  loopRunning = true;
  loopAbort = new AbortController();
  void runLoop(loopAbort.signal);
}

function stopLoop(): void {
  loopRunning = false;
  if (loopAbort) { loopAbort.abort(); loopAbort = null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── QR connect flow ──

async function connectFlow(task: Task, ctx: PluginContext): Promise<TaskResult> {
  try {
    _status = "running";
    const emitQr = async (qrContent: string) => {
      const dataUrl = await QRCode.toDataURL(qrContent, { width: 280, margin: 2, errorCorrectionLevel: "H" });
      ctx.output.platform({ type: "wechat.qrcode", dataUrl });
      // Save as asset for Dashboard
      const b64 = dataUrl.split(",")[1]!;
      const qrPath = path.join(dataDir(), "qrcode.png");
      fs.ensureDirSync(dataDir());
      fs.writeFileSync(qrPath, Buffer.from(b64, "base64"));
      ctx.createAsset(task.id, "image/png", qrPath, "wechat-qrcode.png", fs.statSync(qrPath).size);
    };

    const qr = await fetchQrcode();
    _ctx?.logger.info("二维码已获取，等待扫码...");
    await emitQr(qr.qrcodeContent);

    // Poll for 5 minutes
    const deadline = Date.now() + 5 * 60_000;
    let qrcode = qr.qrcode;
    while (Date.now() < deadline) {
      let resp;
      try { resp = await fetchQrcodeStatus(qrcode); } catch { await sleep(1500); continue; }

      if (resp.status === "expired") {
        const newQr = await fetchQrcode();
        qrcode = newQr.qrcode;
        await emitQr(newQr.qrcodeContent);
        _ctx?.logger.info("二维码过期，已刷新");
      } else if (resp.status === "scaned") {
        _ctx?.logger.info("已扫码，等待确认...");
      } else if (resp.status === "confirmed") {
        session = {
          token: resp.bot_token || "",
          baseUrl: resp.baseurl || ILINK_BASE_URL,
          botId: resp.ilink_bot_id || "",
          userId: resp.ilink_user_id || "",
        };
        saveToken(session);
        startLoop();
        _status = "running";
        ctx.output?.platform({ type: "wechat.status", status: "connected" });
        _ctx?.logger.info("微信已连接");
        return { success: true, data: { status: "connected", botId: session.botId } };
      }
      await sleep(1000);
    }
    _status = "idle";
    return { success: false, error: "扫码超时" };
  } catch (e) {
    _status = "error";
    return { success: false, error: (e as Error).message };
  }
}

// ── Plugin ──

const wechatBotPlugin: Plugin = {
  name: "wechat-bot",
  version: "1.0.0",
  description: "微信个人号消息通道",
  usesPiAgent: true,
  skills: [],
  ownSkills: [
    {
      name: "send_wechat_reply",
      label: "回复微信",
      description: "通过微信回复文本消息。to 是联系人 ID，text 是回复内容，contextToken 可选（从消息中获取）。",
      parameters: Type.Object({
        to: Type.String(),
        text: Type.String(),
        contextToken: Type.Optional(Type.String()),
      }),
      execute: async (_tid: string, raw: unknown) => {
        const { to, text, contextToken } = raw as { to: string; text: string; contextToken?: string };
        if (!to || !text) return { content: [{ type: "text", text: `错误: 缺少必需参数 to="${to}" text="${text}"。收到 raw=${JSON.stringify(raw)}。请确保调用 send_wechat_reply 时传 to 和 text。` }], details: { ok: false } };
        await pluginManager.submitTask("wechat-bot", { action: "send_reply", to, text, contextToken });
        return { content: [{ type: "text", text: `已回复 ${to}: ${text.slice(0, 50)}` }], details: {} };
      },
    },
    {
      name: "send_wechat_image",
      label: "发送微信图片",
      description: "通过微信发送图片。to 是联系人 ID，filePath 是图片绝对路径，contextToken 可选。",
      parameters: Type.Object({
        to: Type.String(),
        filePath: Type.String(),
        contextToken: Type.Optional(Type.String()),
      }),
      execute: async (_tid: string, raw: unknown) => {
        const { to, filePath, contextToken } = raw as { to: string; filePath: string; contextToken?: string };
        if (!to || !filePath) return { content: [{ type: "text", text: "错误: 缺少必需参数 to 或 filePath" }], details: { ok: false } };
        await pluginManager.submitTask("wechat-bot", { action: "send_image", to, filePath, contextToken });
        return { content: [{ type: "text", text: `已发送图片给 ${to}` }], details: {} };
      },
    },
    {
      name: "manage_wechat_contact",
      label: "管理微信联系人",
      description: "设置联系人的处理模式。contact 是联系人 ID，mode 为 auto_reply（自动回复）/ notify（仅通知）/ ignore（忽略）。",
      parameters: Type.Object({
        contact: Type.String(),
        mode: Type.String(),
      }),
      execute: async (_tid: string, raw: unknown) => {
        const { contact, mode } = raw as { contact: string; mode: string };
        if (!contact || !mode) return { content: [{ type: "text", text: "错误: 缺少必需参数 contact 或 mode（mode: auto_reply | notify | ignore）" }], details: { ok: false } };
        if (!["auto_reply", "notify", "ignore"].includes(mode)) return { content: [{ type: "text", text: `错误: mode 必须是 auto_reply / notify / ignore，收到: ${mode}` }], details: { ok: false } };
        await pluginManager.submitTask("wechat-bot", { action: "set_rule", contact, mode });
        return { content: [{ type: "text", text: `联系人 ${contact} 已设为 ${mode}` }], details: {} };
      },
    },
    {
      name: "list_wechat_contacts",
      label: "列出微信联系人",
      description: "列出所有微信联系人的规则配置。",
      parameters: Type.Object({}),
      execute: async (_tid: string, _raw: unknown) => {
        await pluginManager.submitTask("wechat-bot", { action: "list_rules" });
        return { content: [{ type: "text", text: "已请求联系人列表" }], details: {} };
      },
    },
  ],

  async init(config: PluginConfig) {
    _rootDir = config.rootDir;
    loadRules();
    const saved = loadToken();
    if (saved) {
      session = saved;
      plog("session 已恢复，等待 output 通道就绪...");
      // Don't start loop yet — _output is null until first execute()
    }
  },

  async start() {
    if (session) { _status = "running"; startLoop(); }
    else _status = "idle";
  },
  async stop() {
    stopLoop();
    if (session) {
      try { await notifyStop(session); } catch { /* ignore */ }
    }
    _status = "idle";
  },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _ctx = ctx;
    if (!_output) {
      _output = ctx.output;
      // Output channel now available — start loop if session exists
      if (session && !loopRunning) { _ctx?.logger.info("output 就绪，启动消息循环"); startLoop(); }
    }
    // Bind ctx.aborted to our loop abort flag
    const checkAbort = () => { if (ctx.aborted) { _aborted = true; stopLoop(); } };

    const action = (task.params.action as string) || "connect";

    if (action === "connect") {
      _aborted = false;
      if (loopRunning) return { success: true, data: { status: "already_connected" } };
      return await connectFlow(task, ctx);
    }

    if (action === "disconnect") {
      _aborted = true;
      stopLoop();
      if (session) { try { await notifyStop(session); } catch { /* ignore */ } }
      session = null;
      clearToken();
      _status = "idle";
      ctx.output?.platform({ type: "wechat.status", status: "disconnected" });
      return { success: true, data: { status: "disconnected" } };
    }

    if (action === "set_rule") {
      const contact = task.params.contact as string;
      const mode = (task.params.mode as string) || "notify";
      if (!contact) return { success: false, error: "缺少 contact 参数" };
      if (mode !== "auto_reply" && mode !== "notify" && mode !== "ignore") {
        return { success: false, error: "mode 必须是 auto_reply | notify | ignore" };
      }
      contactRules.set(contact, { displayName: contact, mode });
      saveRules();
      _ctx?.logger.info(`联系人规则: ${contact} → ${mode}`);
      return { success: true, data: { contact, mode } };
    }

    if (action === "send_reply") {
      const to = task.params.to as string;
      const text = task.params.text as string;
      const ct = task.params.contextToken as string | undefined;
      if (!to || !text) return { success: false, error: "缺少 to 或 text 参数" };
      _ctx?.logger.info(`回复微信 ${to}: ${text}`);
      await sendReply(to, text, ct);
      return { success: true, data: { to, text: text.slice(0, 50) } };
    }

    if (action === "send_image") {
      const to = task.params.to as string;
      const filePath = task.params.filePath as string;
      const ct = task.params.contextToken as string | undefined;
      if (!to || !filePath) return { success: false, error: "缺少 to 或 filePath 参数" };
      await sendImageReply(to, filePath, ct);
      return { success: true, data: { to } };
    }

    // deliver_reply — Agent response delivered back to WeChat
    if (action === "deliver_reply") {
      const content = (task.params.content as any[]) || [];
      const pd = (task.params.pluginData as { to: string; contextToken?: string }) || {};
      const to = pd.to;
      const ct = pd.contextToken;
      if (!to) return { success: false, error: "缺少 to 参数" };

      const textBlocks = content.filter((b: any) => b.type === "text");
      const rawText = textBlocks.map((b: any) => b.text).join("\n").trim();

      // Collect file references and strip Markdown
      const files: { path: string; mime: string }[] = [];
      const cleanText = rawText
        .replace(/!\[[^\]]*\]\(\/api\/file\?path=([^)]+)\)/g, (_m, p1) => {
          const fp = decodeURIComponent(p1);
          const ext = fp.split(".").pop()?.toLowerCase() || "";
          if (/^(png|jpe?g|gif|webp)$/i.test(ext)) files.push({ path: fp, mime: `image/${ext}` });
          return "";
        })
        .trim();

      if (cleanText) {
        _ctx?.logger.info(`回复微信 ${to}: ${cleanText.slice(0, 50)}`);
        await sendReply(to, cleanText, ct);
      }
      for (const f of files) {
        _ctx?.logger.info(`发送图片给 ${to}: ${f.path}`);
        await sendImageReply(to, f.path, ct);
      }
      return { success: true, data: { to, textLen: cleanText.length, images: files.length } };
    }

    // list_rules
    if (action === "list_rules") {
      const rules = Object.fromEntries(contactRules);
      return { success: true, data: { rules } };
    }

    return { success: false, error: `未知 action: ${action}` };
  },

  async resume(taskId: string, _checkpoint: unknown, ctx: PluginContext): Promise<void> {
    _ctx = ctx;
    // 恢复连接（如果 token 还在）
    if (!session) {
      const saved = loadToken();
      if (saved) { session = saved; startLoop(); }
    }
  },
};

export default wechatBotPlugin;

// ── Public API (called by server.ts / Dashboard Agent tools) ──

export function getSession(): IlinkSession | null { return session; }
export function getContactRules() { return contactRules; }

export async function sendReply(to: string, text: string, contextToken?: string): Promise<void> {
  if (!session) throw new Error("微信未连接");
  await sendText(session, to, text, contextToken);
}

export async function sendImageReply(to: string, filePath: string, contextToken?: string): Promise<void> {
  if (!session) throw new Error("微信未连接");
  const { sendImage } = await import("./ilink-client.js");
  await sendImage(session, to, filePath, contextToken);
}
