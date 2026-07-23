// ============================================================================
// X-Scrape Plugin — X.com image scraper
// ============================================================================

import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT } from "../../src/core/config.js";
import { createAgentModel } from "../../src/core/llm.js";
import { openPluginDB } from "../../src/core/db.js";
import { ERR_SERVICE_DOWN, ERR_TIMEOUT, errMsg } from "../../src/core/error-codes.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";

let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
let _rawDir: string, _dbPath: string, _tmpScreenshot: string, _promptPath: string;
let _logStream: ReturnType<typeof fs.createWriteStream> | null = null;
let _db: Database.Database;

function plog(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  _logStream?.write(`[${ts}] ${msg}\n`);
}

function initPaths() {
  _rawDir = path.join(ROOT, "data", "x-scrape");          // 成果数据（图片）
  _dbPath = path.join(_rootDir, "images.db");              // 插件内部 DB
  _tmpScreenshot = path.join(_rootDir, "viewer.png");      // 插件内部临时文件
  _promptPath = path.join(_rootDir, "prompt.md");
  fs.ensureDirSync(_rawDir);
  const logDir = path.join(ROOT, "logs", "x-scrape");
  fs.ensureDirSync(logDir);
  _logStream = fs.createWriteStream(path.join(logDir, "scrape.log"), { flags: "a" });
  _db = openPluginDB(_dbPath);
  _db.exec("CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, url TEXT UNIQUE, username TEXT, is_valid INTEGER, source_tweet_url TEXT, tweet_hash TEXT)");
}

const HOME_URL = "https://x.com/home";

// ============================================================================
// agent-browser + SQLite helpers
// ============================================================================

function ab(c: string): string {
  try {
    return execSync(`agent-browser ${c}`, {
      encoding: "utf-8", timeout: 60000, maxBuffer: 20 * 1024 * 1024, windowsHide: true,
    }).trim();
  } catch (e: any) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().slice(0, 200);
    if (msg.includes("ETIMEDOUT") || msg.includes("killed")) throw new Error(errMsg(ERR_TIMEOUT, "agent-browser 无响应"));
    throw new Error(errMsg(ERR_SERVICE_DOWN, msg));
  }
}


function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function getCdn(): string {
  const js = String.raw`(()=>{const n=parseInt(window.location.href.match(/\/photo\/(\d+)/)?.[1]||1);const imgs=document.querySelectorAll('img[alt="图像"]');return imgs[n-1]?.src||''})()`;
  const f = path.join(_rawDir, ".cdn.js");
  fs.writeFileSync(f, js, "utf-8");
  const r = execSync(`cmd /c "type "${f}" | agent-browser eval --stdin"`, {
    encoding: "utf-8", timeout: 15000, maxBuffer: 65536, windowsHide: true,
  }).trim() || "";
  fs.removeSync(f);
  return r.replace(/^"/, "").replace(/"$/, "");
}

// ============================================================================
// Navigation
// ============================================================================

function findNextImage(
  seenHashes: Set<string>, dl: { v: number }, sk: { v: number }, jk: { v: number },
  _state: { user: string; tweet: string; cdn: string },
): { image: string; data: string } | null {
  let noNewCount = 0;
  const seen = new Set<string>();

  while (true) {
    let t = ab("snapshot -i");
    if (t.includes("幻灯片") || t.includes('button "关闭"')) {
      const cm = t.match(/button "关闭" \[ref=(e\d+)\]/);
      if (cm) try { ab(`click ${cm[1]}`) } catch {}
      else try { ab(`eval "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"`) } catch {}
      t = ab("snapshot -i");
    }
    if (!t.includes("主页时间线") && !t.includes("x.com/home")) {
      ab(`eval "window.location.href='${HOME_URL}'"`);
      return null;
    }

    const articles = t.split(/- article "/).filter(a => a.includes('link "图像"'));

    for (const a of articles) {
      if (/広告|g123\.jp|Promoted|付费合作|广告|推广/.test(a)) continue;
      const aKey = sha(a.replace(/\[ref=e\d+\]/g, "").replace(/\s+/g, " ").trim().slice(0, 200));
      if (seen.has(aKey)) continue;
      seen.add(aKey);

      const um = a.match(/link "@(\w+)"/);
      const user = (um && um[1]) ? um[1] : "?";
      if (seenHashes.has(`user:${user}`)) continue;

      const rm = a.match(/link "图像" \[ref=(e\d+)\]/);
      if (!rm || !rm[1]) continue;
      const ref = rm[1];

      try { ab(`eval "document.body.click()"`) } catch {}
      try { ab(`click ${ref}`) } catch { continue }

      const u = ab(`eval "window.location.href"`);
      if (!u.includes("/photo/") && !u.includes("/status/")) {
        ab(`eval "window.location.href='${HOME_URL}'"`);
        continue;
      }

      const h = sha(u);
      if (_db.prepare("SELECT id FROM images WHERE tweet_hash = ? OR source_tweet_url = ? LIMIT 1").get(h, u)) {
        sk.v++;
        const ct = ab("snapshot -i").match(/button "关闭" \[ref=(e\d+)\]/);
        if (ct) try { ab(`click ${ct[1]}`) } catch {}
        continue;
      }

      const cdn = getCdn();
      if (!cdn) continue;
      if (_db.prepare("SELECT id FROM images WHERE url = ? LIMIT 1").get(cdn)) {
        sk.v++;
        continue;
      }

      ab(`screenshot "${_tmpScreenshot}"`);
      const data = fs.existsSync(_tmpScreenshot) ? fs.readFileSync(_tmpScreenshot).toString("base64") : "";
      if (!data) continue;

      _state.user = user; _state.tweet = u; _state.cdn = cdn;
      return { image: `@${user}`, data };
    }

    noNewCount++;
    if (noNewCount <= 2) ab(`eval "window.scrollBy(0,800)"`);
    else { ab(`eval "window.location.href='${HOME_URL}'"`); noNewCount = 0; }
  }
}

function closeViewer() {
  const t = ab("snapshot -i");
  const cm = t.match(/button "关闭" \[ref=(e\d+)\]/);
  if (cm) try { ab(`click ${cm[1]}`) } catch {}
}

function nextSlide(user: string, tweet: string, cdn: string, _state: { user: string; tweet: string; cdn: string }): { image: string; data: string } | null {
  const t = ab("snapshot -i");
  const nm = t.match(/button "下一张幻灯片" \[ref=(e\d+)\]/);
  if (!nm) return null;
  const prevUrl = tweet;
  ab(`click ${nm[1]}`);
  for (let w = 0; w < 10; w++) { tweet = ab(`eval "window.location.href"`) || tweet; if (tweet !== prevUrl) break; }
  cdn = getCdn();
  if (tweet === prevUrl || !cdn) return null;
  ab(`screenshot "${_tmpScreenshot}"`);
  const d = fs.existsSync(_tmpScreenshot) ? fs.readFileSync(_tmpScreenshot).toString("base64") : "";
  if (!d) return null;
  _state.tweet = tweet; _state.cdn = cdn;
  return { image: `@${user}`, data: d };
}

// ============================================================================
// Plugin
// ============================================================================

const xScrapePlugin: Plugin = {
  name: "x-scrape",
  version: "1.0.0",
  description: "X.com 图片爬取器",
  usesPiAgent: true,
  skills: [],
  ownSkills: [],

  async init(config: PluginConfig) {
    _rootDir = config.rootDir;
    initPaths();
  },
  async start() { _status = "idle"; },
  async stop() { _status = "idle"; },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _status = "running";
    const maxCount = (task.params.count as number) ?? Infinity;

    const promptText = fs.existsSync(_promptPath) ? fs.readFileSync(_promptPath, "utf-8") : "Download portrait/character images. keep() or junk().";

    // Verify browser
    let t: string;
    try {
      t = ab("snapshot -i");
    } catch (err) {
      _status = "error";
      const msg = err instanceof Error ? err.message : String(err);
      ctx.eventBus.emit("task.error", { taskId: task.id, errorCode: ERR_SERVICE_DOWN, rawError: msg, pluginName: "x-scrape" });
      return { success: false, error: msg };
    }
    if (!t.includes("主页时间线") && !t.includes("x.com/home")) {
      _status = "error";
      return { success: false, error: "浏览器不在 X.com 主页" };
    }

    const seenHashes = new Set<string>();
    const _state = { user: "", tweet: "", cdn: "" };
    const dl = { v: 0 }, sk = { v: 0 }, jk = { v: 0 };
    let cyc = 0;

    plog("X-Scrape started");
    ctx.eventBus.emit("task.progress", { taskId: task.id, progress: 0, step: "checking_page" });

    try {

    const first = findNextImage(seenHashes, dl, sk, jk, _state);
    if (!first) {
      _status = "idle";
      return { success: true, data: { message: "首页无图片" } };
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: promptText,
        model: createAgentModel({ name: "LLM", supportsImages: true }),
        thinkingLevel: "high",
      },
      toolExecution: "sequential",
      getApiKey: async () => "not-needed",
    });

    agent.state.tools = [
      {
        name: "keep", label: "保存", description: "下载当前图片",
        parameters: Type.Object({}),
        execute: async () => {
          if (ctx.aborted) return { content: [{ type: "text", text: "cancelled" }], details: {}, terminate: true };
          const fn = `${_state.user || "img"}-${Date.now()}.jpg`;
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 30000);
            const res = await fetch(_state.cdn, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) {
              const filepath = path.join(_rawDir, fn);
              fs.writeFileSync(filepath, Buffer.from(await res.arrayBuffer()));
              dl.v++;
              ctx.createAsset(task.id, "image/jpeg", filepath, fn, fs.statSync(filepath).size, { source: "x.com" });
            }
          } catch (e: any) { plog(`Download failed: ${(e.message || "").slice(0, 80)}`); }

          const h = sha(_state.tweet);
          seenHashes.add(h);
          seenHashes.add(`user:${_state.user}`);
          _db.prepare("INSERT OR IGNORE INTO images(filename,url,username,is_valid,source_tweet_url,tweet_hash) VALUES(?,?,?,1,?,?)").run(fn, _state.cdn, _state.user, _state.tweet, h);

          ctx.eventBus.emit("task.progress", { taskId: task.id, progress: Math.min(dl.v / maxCount, 1), step: `downloaded_${dl.v}` });

          // Next slide or tweet
          const ns = nextSlide(_state.user, _state.tweet, _state.cdn, _state);
          if (ns) {
            cyc++;
            if (cyc % 5 === 0) plog(`Downloaded: ${dl.v}, Skipped: ${sk.v}, Junk: ${jk.v}`);
            return { content: [{ type: "text", text: ns.image }, { type: "image", data: ns.data, mimeType: "image/png" }], details: {} };
          }
          closeViewer();
          if (dl.v >= maxCount) {
            plog(`Done: ${dl.v} images`);
            _status = "idle";
            return { content: [{ type: "text", text: "done" }], details: {} };
          }
          const next = findNextImage(seenHashes, dl, sk, jk, _state);
          if (!next) {
            ab(`eval "window.location.href='${HOME_URL}'"`);
            await new Promise(r => setTimeout(r, 3000));
            const r = findNextImage(seenHashes, dl, sk, jk, _state);
            if (!r) {
              _status = "idle";
              return { content: [{ type: "text", text: "done" }], details: {} };
            }
            return { content: [{ type: "text", text: r.image }, { type: "image", data: r.data, mimeType: "image/png" }], details: {} };
          }
          return { content: [{ type: "text", text: next.image }, { type: "image", data: next.data, mimeType: "image/png" }], details: {} };
        },
      },
      {
        name: "junk", label: "垃圾", description: "标记为垃圾",
        parameters: Type.Object({}),
        execute: async () => {
          if (ctx.aborted) return { content: [{ type: "text", text: "cancelled" }], details: {}, terminate: true };
          jk.v++;
          const h = sha(_state.tweet);
          seenHashes.add(h);
          seenHashes.add(`user:${_state.user}`);
          _db.prepare("INSERT OR IGNORE INTO images(filename,url,username,is_valid,source_tweet_url,tweet_hash) VALUES('skip',?,?,-1,?,?)").run(_state.cdn, _state.user, _state.tweet, h);

          const ns = nextSlide(_state.user, _state.tweet, _state.cdn, _state);
          if (ns) {
            cyc++;
            if (cyc % 10 === 0) plog(`Junk: ${jk.v}, Downloaded: ${dl.v}`);
            return { content: [{ type: "text", text: ns.image }, { type: "image", data: ns.data, mimeType: "image/png" }], details: {} };
          }
          closeViewer();
          if (dl.v >= maxCount) {
            _status = "idle";
            return { content: [{ type: "text", text: "done" }], details: {} };
          }
          const next = findNextImage(seenHashes, dl, sk, jk, _state);
          if (!next) {
            ab(`eval "window.location.href='${HOME_URL}'"`);
            await new Promise(r => setTimeout(r, 3000));
            const r = findNextImage(seenHashes, dl, sk, jk, _state);
            if (!r) {
              _status = "idle";
              return { content: [{ type: "text", text: "done" }], details: {} };
            }
            return { content: [{ type: "text", text: r.image }, { type: "image", data: r.data, mimeType: "image/png" }], details: {} };
          }
          return { content: [{ type: "text", text: next.image }, { type: "image", data: next.data, mimeType: "image/png" }], details: {} };
        },
      },
    ];

    agent.prompt("判断这张图片: keep() 或 junk()", [{
      type: "image", data: first.data, mimeType: "image/png",
    }]).then(() => {}).catch(() => {});

    await agent.waitForIdle();
    _status = "idle";
    ctx.eventBus.emit("task.completed", { taskId: task.id, data: { downloaded: dl.v, skipped: sk.v, junk: jk.v } });
    return { success: true, data: { downloaded: dl.v, skipped: sk.v, junk: jk.v } };

    } catch (err) {
      _status = "error";
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode = msg.startsWith("ERR_") ? msg.split(":")[0]! : ERR_SERVICE_DOWN;
      ctx.eventBus.emit("task.error", { taskId: task.id, errorCode, rawError: msg, pluginName: "x-scrape" });
      return { success: false, error: msg };
    }
  },

  async resume(taskId: string, checkpoint: unknown, ctx: PluginContext): Promise<void> {
    const params = (checkpoint && typeof checkpoint === "object" && "params" in (checkpoint as any))
      ? (checkpoint as any).params as Record<string, unknown>
      : {};
    const task: Task = { id: taskId, pluginName: "x-scrape", params };
    await this.execute(task, ctx);
  },
};

export default xScrapePlugin;
