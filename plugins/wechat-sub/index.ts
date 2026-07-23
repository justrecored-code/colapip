/**
 * WeChat Sub Plugin — 公众号订阅管理
 *
 * 搜索公众号 → 订阅 → 定时轮询 → 下载文章 → AI 摘要。
 * 登录凭证从 wechat-api/.env 读取（用 wechat-api 的 login.html 扫码）。
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT } from "../../src/core/config.js";
import { openPluginDB } from "../../src/core/db.js";
import { ERR_SERVICE_DOWN, ERR_TIMEOUT, ERR_AUTH } from "../../src/core/error-codes.js";
import http from "http";
import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";

// ── State ──
let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
let _pollCtx: PluginContext | null = null;  // only for polling timer, never shared with tasks
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _logStream: ReturnType<typeof fs.createWriteStream> | null = null;
let _db: Database.Database;
let _loginServer: http.Server | null = null;
let _loginPort = 0;

function plog(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  _logStream?.write(`[${ts}] ${msg}\n`);
}

// ── Paths ──
function dbPath(): string { return path.join(_rootDir, "wechat-sub.db"); }          // 插件内部
function articlesDir(): string { return path.join(ROOT, "data", "assets", "wechat-articles"); }  // 成果数据

function initDB(): void {
  fs.ensureDirSync(path.dirname(dbPath()));
  fs.ensureDirSync(articlesDir());
  const logDir = path.join(ROOT, "logs", "wechat-sub");
  fs.ensureDirSync(logDir);
  _logStream = fs.createWriteStream(path.join(logDir, "sub.log"), { flags: "a" });
  _db = openPluginDB(dbPath());
  _db.exec(`CREATE TABLE IF NOT EXISTS subs (
    fakeid TEXT PRIMARY KEY, nickname TEXT, alias TEXT, subscribed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fakeid TEXT, title TEXT, link TEXT UNIQUE,
    digest TEXT, author TEXT, publish_time INTEGER,
    summary TEXT, md_path TEXT, fetched_at TEXT
  );`);
}

// ── Credentials ──

function tokenPath(): string { return path.join(_rootDir, "token.json"); }

function loadCreds(): { token: string; cookie: string } | null {
  try {
    const p = tokenPath();
    if (!fs.existsSync(p)) return null;
    return fs.readJSONSync(p);
  } catch { return null; }
}

// ── WeChat MP API client ──
const MP_BASE = "https://mp.weixin.qq.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function mpGet(url: string, params: Record<string, string> = {}): Promise<any> {
  const creds = loadCreds();
  if (creds) { params.token = creds.token; params.lang = "zh_CN"; params.f = "json"; params.ajax = "1"; }
  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${MP_BASE}${url}${qs ? "?" + qs : ""}`;
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (creds) headers.Cookie = creds.cookie;
  const resp = await fetch(fullUrl, { headers });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── Actions ──

async function searchAccounts(query: string, ctx: PluginContext): Promise<TaskResult> {
  plog(`搜索公众号: ${query}`);
  try {
    const r = await mpGet("/cgi-bin/searchbiz", { action: "search_biz", query, count: "10" });
    const list = r?.list || [];
    const items = list.map((a: any) => `${a.nickname} (fakeid: ${a.fakeid}) - ${a.signature?.slice(0, 40) || ""}`);
    return { success: true, data: { results: list.length, items } };
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg.includes("timeout") ? ERR_TIMEOUT : msg.includes("Auth") ? ERR_AUTH : ERR_SERVICE_DOWN;
    ctx.eventBus.emit("task.error", { taskId: "", errorCode: code, rawError: msg, pluginName: "wechat-sub" });
    return { success: false, error: msg };
  }
}

async function subscribeAccount(fakeid: string, nickname: string, ctx: PluginContext): Promise<TaskResult> {
  plog(`订阅: ${nickname || fakeid}`);
  try {
    // Try to get official nickname, fall back to the one from search
    let nick = nickname;
    try {
      const info = await mpGet("/cgi-bin/getaccountinfo", { fakeid, action: "get_account_info" });
      if (info?.nickname) nick = info.nickname;
    } catch { /* use search nickname */ }
    if (!nick) nick = fakeid;
    _db.prepare("INSERT OR REPLACE INTO subs(fakeid, nickname, subscribed_at) VALUES(?,?,datetime('now','localtime'))").run(fakeid, nick);
    writeUIState(!!_pollTimer, 3600);
    plog(`已订阅: ${nick}`);

    const articles = await fetchArticles(fakeid, 20);
    plog(`获取到 ${articles.length} 篇文章`);
    for (const a of articles) await downloadAndAnalyze(fakeid, a, ctx);
    return { success: true, data: { fakeid, nickname: nick, articleCount: articles.length } };
  } catch (e) {
    const msg = (e as Error).message;
    ctx.eventBus.emit("task.error", { taskId: "", errorCode: ERR_SERVICE_DOWN, rawError: msg, pluginName: "wechat-sub" });
    return { success: false, error: msg };
  }
}

async function fetchArticles(fakeid: string, limit: number = 20, offset: number = 0): Promise<any[]> {
  try {
    const r = await mpGet("/cgi-bin/appmsgpublish", { sub: "list", sub_action: "list_ex", search_field: "null", begin: String(offset), count: String(limit), query: "", fakeid, type: "101_1", free_publish_type: "1" });
    let publishPage = r?.publish_page || {};
    if (typeof publishPage === "string") { try { publishPage = JSON.parse(publishPage); } catch { return []; } }
    const publishList = publishPage.publish_list || [];
    const articles: any[] = [];
    for (const item of publishList) {
      const info = typeof item.publish_info === "string" ? JSON.parse(item.publish_info) : (item.publish_info || {});
      for (const a of (info.appmsgex || [])) {
        articles.push({ title: a.title || "", link: a.link || "", digest: a.digest || "", author: a.author || "", publish_time: a.create_time || Math.floor(Date.now() / 1000) });
      }
    }
    return articles;
  } catch { return []; }
}

async function downloadAndAnalyze(fakeid: string, article: any, ctx: PluginContext): Promise<boolean> {
  if (ctx.aborted) return false;
  const { title, link, digest, author, publish_time } = article;
  if (_db.prepare("SELECT id FROM articles WHERE link = ?").get(link || "")) return false;

  plog(`下载: ${title?.slice(0, 40)}`);
  if (ctx.aborted) return false;
  let content = "";
  try {
    const resp = await fetch(link, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://mp.weixin.qq.com/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    const html = await resp.text();
    if (ctx.aborted) return false; // paused/cancelled during download

    // Skip deleted / verification pages
    if (html.includes("环境异常") || html.includes("该内容已被发布者删除") || html.includes("涉嫌违反相关法律法规")) {
      plog(`  ⚠ 不可用: ${title?.slice(0, 40)}`);
      return false;
    }

    // Extract content (ported from wechat-api's extract_article_info)
    const itemType = (html.match(/window\.item_show_type\s*=\s*'(\d+)'/) || [])[1] || "0";
    let rawHtml = "";

    if (itemType === "8") {
      // Image-text message — extract from meta description
      const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
      if (descMatch) rawHtml = descMatch[1]!.replace(/\\x([0-9a-fA-F]{2})/g, (_:string, h:string) => String.fromCharCode(parseInt(h, 16))).replace(/<[^>]+>/g, "");
    } else if (itemType === "10") {
      // Short content — extract from content_noencode
      const cnMatch = html.match(/content_noencode\s*:\s*(?:JsDecode\(')?([^'{30,}]*?)'?\s*(?:\))?,?\s*\n/);
      if (cnMatch) rawHtml = cnMatch[1]!.replace(/\\x([0-9a-fA-F]{2})/g, (_:string, h:string) => String.fromCharCode(parseInt(h, 16)));
    } else {
      // Normal article — extract from js_content div
      const jsPos = html.indexOf('id="js_content"');
      if (jsPos > 0) {
        const start = html.indexOf('>', jsPos) + 1;
        // Find matching closing div by counting depth
        let depth = 1, end = start;
        while (depth > 0 && end < html.length - 6) {
          const nextOpen = html.indexOf('<div', end);
          const nextClose = html.indexOf('</div>', end);
          if (nextClose < 0) break;
          if (nextOpen > 0 && nextOpen < nextClose) { depth++; end = nextOpen + 4; }
          else { depth--; end = nextClose + 6; }
        }
        if (end > start) rawHtml = html.slice(start, end - 6);
      }
      // Fallback: rich_media_content
      if (!rawHtml) {
        const rmMatch = html.match(/class="rich_media_content"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="rich_media_area_extra/i);
        if (rmMatch) rawHtml = rmMatch[1]!;
      }
    }

    // Convert HTML to plain text
    if (rawHtml) {
      // Remove scripts and styles
      rawHtml = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      // Block elements → newlines
      rawHtml = rawHtml.replace(/<br\s*\/?\s*>/gi, "\n");
      rawHtml = rawHtml.replace(/<\/(?:p|div|section|h[1-6]|tr|li|blockquote|article)>/gi, "\n");
      // Strip remaining tags
      content = rawHtml.replace(/<[^>]+>/g, "");
      // Decode entities
      content = content.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
      // Collapse whitespace
      content = content.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }

    if (!content) { plog(`  ⚠ 无正文 (type=${itemType}): ${title?.slice(0, 40)}`); return false; }
  } catch { plog(`  ⚠ 下载失败: ${title?.slice(0, 40)}`); return false; }

  // Per-subscription folder + date-prefixed filename
  const nickRow = _db.prepare("SELECT nickname FROM subs WHERE fakeid = ?").get(fakeid) as {nickname: string} | undefined;
  const subDir = nickRow?.nickname ? path.join(articlesDir(), sanitize(nickRow.nickname)) : articlesDir();
  fs.ensureDirSync(subDir);
  const dateStr = new Date(publish_time * 1000).toISOString().slice(0, 10);
  const fn = `${dateStr}-${sanitize(title || "article").slice(0, 60)}.md`;
  const mdPath = path.join(subDir, fn);
  const md = `# ${title}\n\n> ${author} | ${dateStr}\n\n${content}`;
  fs.writeFileSync(mdPath, md, "utf-8");
  ctx.createAsset("", "text/markdown", mdPath, fn, fs.statSync(mdPath).size, { author, title, fakeid });

  _db.prepare("INSERT OR REPLACE INTO articles(fakeid, title, link, digest, author, publish_time, summary, md_path, fetched_at) VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))")
    .run(fakeid, title||"", link||"", digest||"", author||"", publish_time||0, digest||"", mdPath);

  writeUIState(!!_pollTimer, 3600);
  ctx.eventBus.emit("wechat-sub.new", { fakeid, title, digest, author });
  return true;
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
}

// ── UI State ──

function writeUIState(polling: boolean, interval: number): void {
  const creds = loadCreds();
  const subs = _db.prepare("SELECT fakeid, nickname, alias, subscribed_at FROM subs ORDER BY subscribed_at DESC").all() as Array<{fakeid:string; nickname:string; alias:string|null; subscribed_at:string}>;
  const arts = _db.prepare("SELECT title, author, digest, summary, publish_time, md_path FROM articles ORDER BY publish_time DESC LIMIT 30").all() as Array<{title:string; author:string; digest:string; summary:string; publish_time:number; md_path:string}>;
  const articles = arts.map(a => ({ ...a, publish_time: a.publish_time * 1000 }));
  fs.writeJSONSync(path.join(_rootDir, "ui-state.json"), {
    subs, articles, polling, interval, loggedIn: !!creds, updatedAt: new Date().toISOString(),
  }, { spaces: 2 });
}

// ── Login server (QR scan proxy → token.json) ──

const LOGIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function startLoginServer(): Promise<void> {
  _loginServer = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || "/", `http://127.0.0.1:${_loginPort}`);
    const pathname = url.pathname;

    try {
      // POST /login/start → create session, return cookies
      if (req.method === "POST" && pathname === "/login/start") {
        const proxyResp = await fetch(`${MP_BASE}/cgi-bin/bizlogin?action=startlogin`, {
          method: "POST", headers: { "User-Agent": LOGIN_UA, Referer: `${MP_BASE}/`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "userlang=zh_CN&redirect_url=&login_type=3&token=&lang=zh_CN&f=json&ajax=1",
        });
        relayCookies(proxyResp, res);
        const data = await proxyResp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }

      // GET /login/qrcode → proxy QR image
      if (req.method === "GET" && pathname === "/login/qrcode") {
        const proxyResp = await fetch(`${MP_BASE}/cgi-bin/scanloginqrcode?action=getqrcode&random=${Date.now()}`, {
          headers: { "User-Agent": LOGIN_UA, Referer: `${MP_BASE}/`, Cookie: req.headers.cookie || "" },
        });
        relayCookies(proxyResp, res);
        const ct = proxyResp.headers.get("content-type") || "image/png";
        const buf = Buffer.from(await proxyResp.arrayBuffer());
        res.writeHead(200, { "Content-Type": ct });
        res.end(buf);
        return;
      }

      // GET /login/scan → poll scan status
      if (req.method === "GET" && pathname === "/login/scan") {
        const proxyResp = await fetch(`${MP_BASE}/cgi-bin/scanloginqrcode?action=ask&token=&lang=zh_CN&f=json&ajax=1`, {
          headers: { "User-Agent": LOGIN_UA, Referer: `${MP_BASE}/`, Cookie: req.headers.cookie || "" },
        });
        relayCookies(proxyResp, res);
        const data = await proxyResp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }

      // POST /login/complete → finish login, extract token
      if (req.method === "POST" && pathname === "/login/complete") {
        const proxyResp = await fetch(`${MP_BASE}/cgi-bin/bizlogin?action=login`, {
          method: "POST", headers: { "User-Agent": LOGIN_UA, Referer: `${MP_BASE}/`, Cookie: req.headers.cookie || "", "Content-Type": "application/x-www-form-urlencoded" },
          body: "userlang=zh_CN&redirect_url=&cookie_forbidden=0&login_type=3&token=&lang=zh_CN&f=json&ajax=1",
        });
        relayCookies(proxyResp, res);
        const data = await proxyResp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }

      // POST /login/save → save credentials to token.json
      if (req.method === "POST" && pathname === "/login/save") {
        const body = await readBody(req);
        const { token, cookie } = JSON.parse(body);
        if (!token || !cookie) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "missing token/cookie" })); return; }
        fs.writeJSONSync(tokenPath(), { token, cookie });
        writeUIState(!!_pollTimer, 3600);
        plog("登录凭据已保存");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /login/cookie → return accumulated cookies (used by UI after login)
      if (req.method === "GET" && pathname === "/login/cookie") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie || "" }));
        return;
      }

      // GET /login/status → quick check
      if (req.method === "GET" && pathname === "/login/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ loggedIn: !!loadCreds() }));
        return;
      }

      res.writeHead(404); res.end("not found");
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  await new Promise<void>((resolve) => {
    _loginServer!.listen(0, "127.0.0.1", () => {
      const addr = _loginServer!.address();
      _loginPort = typeof addr === "object" ? addr!.port : 0;
      plog(`登录服务: http://127.0.0.1:${_loginPort}`);
      resolve();
    });
  });
}

function relayCookies(proxyResp: Response, res: http.ServerResponse): void {
  const setCookies = proxyResp.headers.getSetCookie?.() || [];
  for (const c of setCookies) res.appendHeader("Set-Cookie", c.replace("; Secure", ""));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Polling ──

async function pollAll(ctx: PluginContext): Promise<void> {
  const rows = _db.prepare("SELECT fakeid, nickname FROM subs").all() as Array<{fakeid: string; nickname: string}>;
  for (const sub of rows) {
    if (ctx.aborted) return;
    try {
      const articles = await fetchArticles(sub.fakeid, 5);
      for (const a of articles) {
        if (ctx.aborted) return;
        const exists = _db.prepare("SELECT id FROM articles WHERE link = ?").get(a.link||"");
        if (!exists) await downloadAndAnalyze(sub.fakeid, a, ctx);
      }
    } catch (e) { plog(`轮询 ${sub.nickname} 失败: ${(e as Error).message}`); }
  }
}

// ── Plugin ──

const wechatSubPlugin: Plugin = {
  name: "wechat-sub", version: "1.1.0",
  description: "公众号订阅管理 — 搜索/订阅/下载/轮询，登录用 wechat-api 扫码",
  usesPiAgent: true, skills: ["db_query"], ownSkills: [],

  async init(config: PluginConfig) {
    _rootDir = config.rootDir;
    initDB();
    await startLoginServer();
    writeUIState(false, 0);
    const subCount = _db.prepare("SELECT COUNT(*) as c FROM subs").get() as {c: number};
    if (subCount && subCount.c > 0) {
      _pollTimer = setInterval(() => { if (_pollCtx) pollAll(_pollCtx).catch(e => plog(`轮询异常: ${(e as Error).message}`)); }, 3600_000);
      writeUIState(true, 3600);
    }
  },

  async start() { _status = "idle"; },
  async stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; _pollCtx = null; }
    if (_loginServer) { _loginServer.close(); _loginServer = null; }
    _status = "idle";
  },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _status = "running";
    const action = task.params.action as string || "list";
    const query = task.params.query as string || "";

    try {
      if (action === "search") return await searchAccounts(query, ctx);
      if (action === "subscribe") return await subscribeAccount(query, task.params.nickname as string || "", ctx);
      if (action === "poll") { await pollAll(ctx); writeUIState(!!_pollTimer, _pollTimer ? 3600 : 0); return { success: true, data: { message: "轮询完成" } }; }
      if (action === "start_poll") {
        const interval = ((task.params.interval as number) || 3600) * 1000;
        if (_pollTimer) clearInterval(_pollTimer);
        _pollCtx = ctx;
        _pollTimer = setInterval(() => { if (_pollCtx) pollAll(_pollCtx).catch(e => plog(`轮询异常: ${(e as Error).message}`)); }, interval);
        writeUIState(true, interval / 1000);
        plog(`定时轮询已启动: ${interval / 1000}s`);
        return { success: true, data: { message: `轮询已启动 (${interval / 1000}s间隔)` } };
      }
      if (action === "stop_poll") {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; _pollCtx = null; }
        writeUIState(false, 0);
        plog("定时轮询已停止");
        return { success: true, data: { message: "轮询已停止" } };
      }
      if (action === "fetch_all_history") {
        let rows = _db.prepare("SELECT fakeid, nickname FROM subs").all() as Array<{fakeid: string; nickname: string}>;
        if (query) rows = rows.filter(r => r.fakeid === query || r.nickname.includes(query));
        let total = 0;
        for (let si = 0; si < rows.length; si++) {
          const sub = rows[si]!;
          if (ctx.aborted) break;
          let offset = 0, batch = 0;
          ctx.eventBus.emit("task.progress", { taskId: task.id, progress: si / rows.length, step: `[${si+1}/${rows.length}] ${sub.nickname}` });
          while (true) {
            const articles = await fetchArticles(sub.fakeid, 10, offset);
            if (articles.length === 0) break; batch++;
            for (const a of articles) {
              if (ctx.aborted) break;
              const exists = _db.prepare("SELECT id FROM articles WHERE link = ?").get(a.link||"");
              if (!exists) { await downloadAndAnalyze(sub.fakeid, a, ctx); total++; }
            }
            ctx.eventBus.emit("task.progress", { taskId: task.id, step: `[${si+1}/${rows.length}] ${sub.nickname} · 第${batch}页` });
            offset += 10;
            if (articles.length < 10) break;
          }
        }
        writeUIState(!!_pollTimer, 3600);
        ctx.eventBus.emit("task.progress", { taskId: task.id, progress: 1, step: `完成 · ${total} 篇` });
        return { success: true, data: { downloaded: total } };
      }
      if (action === "unsubscribe") { _db.prepare("DELETE FROM subs WHERE fakeid = ?").run(query); writeUIState(!!_pollTimer, 3600); return { success: true, data: { message: "已退订" } }; }
      if (action === "login_status") { return { success: true, data: { loggedIn: !!loadCreds(), loginPort: _loginPort } }; }
      if (action === "list") {
        const rows = _db.prepare("SELECT fakeid, nickname, subscribed_at FROM subs ORDER BY subscribed_at DESC").all() as Array<{fakeid:string; nickname:string; subscribed_at:string}>;
        const subs = rows.map(r => `${r.fakeid}|${r.nickname}|${r.subscribed_at}`).join("\n");
        return { success: true, data: { subscriptions: subs || "无订阅" } };
      }
      return { success: false, error: `未知 action: ${action}` };
    } finally {
      if (action !== "poll" && action !== "fetch_all_history" && action !== "start_poll" && action !== "stop_poll") _status = "idle";
    }
  },

  async resume(taskId: string, _checkpoint: unknown, ctx: PluginContext): Promise<void> {
    _pollCtx = ctx; await pollAll(ctx);
  },
};

export default wechatSubPlugin;
