/**
 * Knowledge Base Plugin — 分子知识库
 * 每个 .md 文件是一个独立的"分子"，YAML frontmatter + 正文。
 * Obsidian 直接打开 data/knowledge/ 作为 vault 即可编辑。
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT, loadConfig } from "../../src/core/config.js";
import { updateTaskState } from "../../src/core/db.js";
import { createAgentModel } from "../../src/core/llm.js";
import { ERR_SERVICE_DOWN, ERR_AUTH, errMsg } from "../../src/core/error-codes.js";
import { Agent } from "@mariozechner/pi-agent-core";
import fs from "fs-extra";
import path from "path";

// ── State ──
let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
function kbDir(): string { return path.join(ROOT, "data", "knowledge"); }

interface Molecule { file: string; category: string; name: string; tags: string[]; [key: string]: unknown; }

// ── Frontmatter helpers ──
function parseFrontmatter(md: string): Record<string, unknown> | null {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const result: Record<string, unknown> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (!kv) continue;
    const key = kv[1]!;
    let val: unknown = kv[2]!.trim();
    if (val === "[]") val = [];
    else if ((val as string).startsWith("[") && (val as string).endsWith("]")) {
      val = (val as string).slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    }
    result[key] = val;
  }
  return result;
}
function moleculeToMd(m: { name: string; tags: string[]; [k: string]: unknown }): string {
  const lines = ["---", `name: ${m.name}`, `tags: [${m.tags.join(", ")}]`];
  let body = "";
  let question = "";
  for (const [k, v] of Object.entries(m)) {
    if (k === "name" || k === "tags" || k === "file") continue;
    if (k === "summary") { body = String(v); lines.push(`summary: ${body}`); continue; }
    if (k === "question") { question = String(v); lines.push(`question: ${question}`); continue; }
    if (typeof v === "boolean") { lines.push(`${k}: ${v}`); continue; }
    if (typeof v === "string") lines.push(`${k}: ${v}`);
  }
  lines.push("---", "", `# ${m.name}`);
  if (question) lines.push("", `❓ ${question}`, "");
  if (body) lines.push("", body);
  lines.push("");
  return lines.join("\n");
}

function scanAll(): Molecule[] {
  const result: Molecule[] = [];
  if (!fs.existsSync(kbDir())) return result;
  for (const cat of fs.readdirSync(kbDir())) {
    const catDir = path.join(kbDir(), cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const md = fs.readFileSync(path.join(catDir, file), "utf-8");
        const data = parseFrontmatter(md);
        if (!data || !data.name) continue;
        result.push({ file: `${cat}/${file}`, category: cat, name: String(data.name), tags: Array.isArray(data.tags) ? data.tags.map(String) : [], ...data });
      } catch { /* skip */ }
    }
  }
  return result;
}

function searchTags(query: string): Molecule[] {
  const q = query.toLowerCase();
  return scanAll().filter(m => m.name.toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q)) || m.category.toLowerCase().includes(q));
}

// ── Embedding (cosine via llama.cpp /embedding) ──
let _embedCache: { file: string; vec: number[] }[] = [];
async function getEmbedding(text: string): Promise<number[]> {
  const cfg = loadConfig();
  const baseUrl = cfg.llm.baseUrl.replace(/\/v1\/?$/, "");
  const resp = await fetch(`${baseUrl}/embedding`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  if (!resp.ok) { const code = resp.status >= 500 ? ERR_SERVICE_DOWN : ERR_AUTH; throw new Error(`${code}: Embedding ${resp.status}`); }
  const data = await resp.json() as { embedding: number[] };
  return data.embedding;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}
async function buildIndex(): Promise<number> {
  const all = scanAll(); _embedCache = [];
  for (const m of all) { try { _embedCache.push({ file: m.file, vec: await getEmbedding(`${m.name} ${m.tags.join(" ")}`) }); } catch { /* skip */ } }
  return _embedCache.length;
}

// ── Agent helpers ──
function extractText(msgs: any[]): string {
  return msgs.filter((m: any) => m.role === "assistant").flatMap((m: any) => {
    if (typeof m.content === "string") return [{ type: "text", text: m.content }];
    if (Array.isArray(m.content)) return m.content.filter((b: any) => b.type === "text");
    return [];
  }).map((b: any) => b.text).join("\n");
}

// ── Plugin ──
const knowledgeBasePlugin: Plugin = {
  name: "knowledge-base", version: "1.0.0", description: "分子知识库——独立标签条目，搜索+embedding排序，提取+审计Agent", usesPiAgent: true, skills: [], ownSkills: [],
  async init(_config: PluginConfig) { _rootDir = _config.rootDir; fs.ensureDirSync(kbDir()); },
  async start() { _status = "idle"; },
  async stop() { _status = "idle"; },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _status = "running";
    const action = (task.params.action as string) || "search";

    try {
      // ── search ──
      if (action === "search") {
        const query = (task.params.query as string) || "";
        let results = searchTags(query);
        if (_embedCache.length > 0 && query) {
          try {
            const qVec = await getEmbedding(query);
            results = results.map(r => ({ ...r, _score: cosine(qVec, _embedCache.find(c => c.file === r.file)?.vec ?? []) })).sort((a, b) => (b._score || 0) - (a._score || 0)).map(({ _score, ...r }) => r);
          } catch { /* fall through */ }
        }
        const items = results.slice(0, 10).map(m => `[${m.category}] ${m.name}: ${m.tags.join(", ")}`);
        return { success: true, data: { count: results.length, items } };
      }

      // ── rebuild_index ──
      if (action === "rebuild_index") {
        const n = await buildIndex();
        ctx.logger.info(`索引已重建: ${n} 条`);
        return { success: true, data: { indexed: n } };
      }

      // ── add ──
      if (action === "add") {
        const cat = (task.params.category as string) || "note";
        const name = (task.params.name as string) || "未命名";
        const tags = ((task.params.tags as string[]) || []).map(t => t.replace(/\s+/g, "_").toLowerCase());
        const catDir = path.join(kbDir(), cat); fs.ensureDirSync(catDir);
        const fn = sanitize(name) + ".md";
        fs.writeFileSync(path.join(catDir, fn), moleculeToMd({ name, tags }), "utf-8");
        ctx.output.platform({ type: "kb.added", category: cat, name });
        return { success: true, data: { added: `${cat}/${fn}` } };
      }

      // ── import_from_articles ──
      if (action === "import_from_articles") {
        const ad = path.join(ROOT, "data", "assets", "wechat-articles");
        if (!fs.existsSync(ad)) return { success: false, error: "wechat-sub 文章目录不存在" };
        const catDir = path.join(kbDir(), "article"); fs.ensureDirSync(catDir);
        let written = 0;
        function scanDir(d: string) {
          for (const e of fs.readdirSync(d)) {
            const fp = path.join(d, e);
            if (fs.statSync(fp).isDirectory()) { scanDir(fp); continue; }
            if (!e.endsWith(".md")) continue;
            try {
              const md = fs.readFileSync(fp, "utf-8");
              const title = (md.match(/^#\s+(.+)/m) || [])[1]?.trim() || e.replace(".md", "");
              const author = (md.match(/^>\s*(.+?)\s*\|/m) || [])[1]?.trim() || "";
              const slug = sanitize(title);
              const mp = path.join(catDir, `${slug}.md`);
              if (!fs.existsSync(mp)) { fs.writeFileSync(mp, moleculeToMd({ name: title, tags: [title, author].filter(Boolean), source: fp }), "utf-8"); written++; }
            } catch { /* skip */ }
          }
        }
        scanDir(ad);
        return { success: true, data: { molecules: written } };
      }

      // ── import_from_recipes ──
      if (action === "import_from_recipes") {
        const rd = path.join(ROOT, "data", "assets", "recipes");
        if (!fs.existsSync(rd)) return { success: false, error: "recipes 目录不存在" };
        const tagMap: Record<string, Set<string>> = {};
        for (const dir of fs.readdirSync(rd).filter(d => fs.statSync(path.join(rd, d)).isDirectory())) {
          const rp = path.join(rd, dir, "recipe.json");
          if (!fs.existsSync(rp)) continue;
          try {
            const recipe = fs.readJSONSync(rp) as { recipe?: Record<string, Record<string, string[]>> };
            if (!recipe.recipe) continue;
            for (const [, modules] of Object.entries(recipe.recipe)) {
              for (const [cat, tags] of Object.entries(modules)) {
                if (!Array.isArray(tags)) continue;
                if (!tagMap[cat]) tagMap[cat] = new Set();
                for (const t of tags) tagMap[cat].add(t.replace(/\s+/g, "_").toLowerCase());
              }
            }
          } catch { /* skip */ }
        }
        let written = 0;
        for (const [cat, tagSet] of Object.entries(tagMap)) {
          const catDir = path.join(kbDir(), cat); fs.ensureDirSync(catDir);
          for (const tag of tagSet) {
            const fp = path.join(catDir, `${tag}.md`);
            if (!fs.existsSync(fp)) { fs.writeFileSync(fp, moleculeToMd({ name: tag, tags: [tag], source: "recipe-import" }), "utf-8"); written++; }
          }
        }
        return { success: true, data: { categories: Object.keys(tagMap).length, molecules: written } };
      }

      // ── auto_curate ──
      if (action === "auto_curate") {
        const src = (task.params.source as string) || "all"; // "recipes" | "articles" | "all"
        const sources: string[] = [];
        const rd = path.join(ROOT, "data", "assets", "recipes");
        if ((src === "all" || src === "recipes") && fs.existsSync(rd)) {
          for (const dir of fs.readdirSync(rd)) {
            const rp = path.join(rd, dir, "recipe.json");
            if (fs.existsSync(rp)) { try { const r = fs.readJSONSync(rp) as any; if (r.recipe) sources.push(JSON.stringify({ source: dir, recipe: r.recipe }).slice(0, 2000)); } catch {} }
          }
        }
        const ad = path.join(ROOT, "data", "assets", "wechat-articles");
        if ((src === "all" || src === "articles") && fs.existsSync(ad)) {
          const files: { fp: string; name: string; date: string }[] = [];
          function walk(d: string) {
            for (const e of fs.readdirSync(d)) {
              const fp = path.join(d, e);
              if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
              if (!e.endsWith(".md")) continue;
              const dateMatch = e.match(/^(\d{4}-\d{2}-\d{2})-/);
              files.push({ fp, name: e, date: dateMatch?.[1] ?? "0000-00-00" });
            }
          }
          walk(ad);
          // Sort newest first by date prefix in filename
          files.sort((a, b) => b.date.localeCompare(a.date));
          for (const f of files) {
            const md = fs.readFileSync(f.fp, "utf-8");
            const title = (md.match(/^#\s+(.+)/m) || [])[1] || f.name;
            sources.push(JSON.stringify({ source: f.fp, title, excerpt: md.slice(0, 1500) }));
          }
        }
        if (sources.length === 0) return { success: false, error: "无可用数据源" };
        ctx.logger.info(`待分析: ${sources.length} 条内容`);

        // ── Process answered inbox entries → move to formal directory ──
        const inboxDir = path.join(kbDir(), "_inbox");
        if (fs.existsSync(inboxDir)) {
          for (const file of fs.readdirSync(inboxDir)) {
            if (!file.endsWith(".md")) continue;
            const fp = path.join(inboxDir, file);
            const md = fs.readFileSync(fp, "utf-8");
            const data = parseFrontmatter(md);
            if (data?.status === "answered" && data.name && data.category) {
              const targetDir = path.join(kbDir(), String(data.category));
              fs.ensureDirSync(targetDir);
              // Strip uncertain/question/status, keep the rest
              const cleaned = moleculeToMd({
                name: String(data.name),
                tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
                category: String(data.category),
                summary: String(data.summary || ""),
              });
              fs.writeFileSync(path.join(targetDir, `${sanitize(String(data.name))}.md`), cleaned, "utf-8");
              fs.removeSync(fp);
              ctx.logger.info(`  Inbox→入库: ${String(data.category)}/${String(data.name)}`);
            }
          }
        }
        // Re-scan after migration
        const updatedExisting = scanAll();
        const existingSummary = updatedExisting.map(e => `[${e.category}] ${e.name}: ${e.tags.join(", ")}`).join("\n");

        const extractAgent = new Agent({
          initialState: { systemPrompt: `你是知识提取专家。分析输入内容，提取可复用的知识条目。
输出格式：每个条目一个 YAML frontmatter 块，用 --- 分隔。
每个条目包含：
- name: 条目名称（简练）
- category: clothing|scene|pose|style|lighting|character|note
- tags: 短标签列表（每个1-3词，如 [养号, 曝光量]，不要把整句话塞进去）
- summary: 一句话描述核心观点（这段会作为正文）
- uncertain: 仅当你对这个概念不确定、需要补充信息时才写 true（默认不写）
- question: 如果不确定，写出你需要查清楚的具体问题

过滤通用噪声(masterpiece,score_9,newest,1girl等)。
示例（确定条目）：
---
name: 养号成功判定标准
category: note
tags: [养号, 曝光量, 判定标准]
summary: 发布作品后24小时内单条视频曝光量超过500，视为初步养号成功。
---
示例（不确定条目）：
---
name: 外卖CPS
category: note
tags: [CPS, 外卖, 分销]
summary: 通过分享外卖红包链接获得佣金的分销模式。
uncertain: true
question: 外卖CPS的具体佣金比例是多少？是否需要商户端配置？
---
只输出 YAML 块，不要其他文字。`, model: createAgentModel({ name: "KB" }), thinkingLevel: "medium" },
          toolExecution: "sequential", getApiKey: async () => "not-needed",
        });
        const auditAgent = new Agent({
          initialState: { systemPrompt: `你是知识库审计员。对每个待审查条目：
1.与已有知识库比对——name完全相同且tags无新增→跳过
2.name相同tags有缺失→合并补全后通过
3.属于噪声(masterpiece,score_9,1girl等通用标签)→拒绝
4.输出分为两部分：通过的条目(---分隔的YAML块) + 拒绝清单(列出name和原因)
格式示例：
通过：
---
name: cat_ears
tags: [animal ears, headband]
category: character
---
拒绝：1girl(通用噪声) score_9(质量标签)
拒绝部分写在最后，一行一个。`, model: createAgentModel({ name: "KB" }), thinkingLevel: "medium" },
          toolExecution: "sequential", getApiKey: async () => "not-needed",
        });

        ctx.logger.info(`_resumeFrom = ${JSON.stringify(task.params._resumeFrom)}`);
        const rf = task.params._resumeFrom as { idx?: number } | undefined;
        const resumeIdx = rf?.idx ?? 0;
        if (resumeIdx > 0) ctx.logger.info(`从断点恢复: 第${resumeIdx + 1}条开始`);
        let totalAdded = 0, totalSkipped = 0;
        for (let i = resumeIdx; i < sources.length; i++) {
          if (ctx.aborted) return { success: false, error: "cancelled" };
          const s = sources[i]!;
          let label = `#${i + 1}`;
          try { label = JSON.parse(s).source || `#${i + 1}`; } catch {}
          ctx.logger.info(`\n── ${label} (${i + 1}/${sources.length}) ──`);

          // Clear agent context each item to avoid overflow
          (extractAgent.state as any).messages = [];
          try { await extractAgent.prompt(`分析以下内容，提取可复用的知识条目：\n\n${s}`); await extractAgent.waitForIdle(); } catch (e) { ctx.logger.error(`提取失败: ${(e as Error).message}`); return { success: false, error: errMsg(ERR_SERVICE_DOWN, (e as Error).message) }; }
          const eText = extractText((extractAgent.state as any).messages ?? []);
          if (!eText) { ctx.logger.warn("提取空"); return { success: false, error: errMsg(ERR_SERVICE_DOWN, "LLM 返回空内容") }; }
          ctx.logger.info(`提取:\n${eText}`);
          (auditAgent.state as any).messages = [];
          try { await auditAgent.prompt(`已有:\n${existingSummary}\n\n待审查:\n${eText || "(空)"}\n\n审查并输出通过的内容。`); await auditAgent.waitForIdle(); } catch (e) { ctx.logger.error(`审计失败: ${(e as Error).message}`); continue; }
          let aText = extractText((auditAgent.state as any).messages ?? []);
          if (!aText) ctx.logger.warn(`审计空!`);
          ctx.logger.info(`审计:\n${aText || "(空)"}`);

          let round = 1, sourceAdded = 0;
          while (round <= 3) {
            const clean = aText.replace(/```yaml\n?|```\n?/g, "").trim();
            let ra = 0;
            for (const block of clean.split(/\n---\n?/)) {
              const t = block.trim(); if (!t) continue;
              const data = parseFrontmatter(`---\n${t}\n---`);
              if (!data?.name || !data?.category) continue;
              const fn = sanitize(String(data.name)) + ".md";
              const isUncertain = data.uncertain === true || data.uncertain === "true";
              // Uncertain entries → _inbox/ (wait for user answer)
              const parentDir = isUncertain
                ? path.join(kbDir(), "_inbox")
                : path.join(kbDir(), String(data.category));
              const mp = path.join(parentDir, fn);
              fs.ensureDirSync(path.dirname(mp));
              const entry = {
                name: String(data.name),
                tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
                category: String(data.category),
                summary: String(data.summary || ""),
                ...(isUncertain ? { uncertain: true, status: "open", question: String(data.question || "(待补充)") } : {}),
              };
              const existed = fs.existsSync(mp);
              fs.writeFileSync(mp, moleculeToMd(entry), "utf-8");
              ra++;
              if (existed) ctx.logger.info(`  覆盖: ${isUncertain ? "_inbox" : String(data.category)}/${String(data.name)}`);
            }
            sourceAdded += ra;
            if (ra > 0) break;
            if (round >= 3) break;
            round++;
            ctx.logger.info(`  零通过，重试${round}...`);
            try { await extractAgent.prompt(`重新提取，确保name+tags+category完整：\n${aText.slice(0, 500)}`); await extractAgent.waitForIdle(); await auditAgent.prompt(`已有:\n${existingSummary}\n\n待审查:\n${extractText((extractAgent.state as any).messages ?? [])}\n\n审查通过。`); await auditAgent.waitForIdle(); aText = extractText((auditAgent.state as any).messages ?? []); } catch { break; }
          }
          totalAdded += sourceAdded;
          if (sourceAdded === 0) {
            const rejected = aText.match(/拒绝[：:]\s*(.+)/i);
            if (rejected) ctx.logger.info(`  拒绝原因: ${rejected[1]}`);
            totalSkipped++;
          }
          ctx.logger.info(`  → ${sourceAdded} 入库`);
          // Save checkpoint: resume from next item on restart
          if (sources.length > 1 && i + 1 < sources.length) {
            updateTaskState(task.id, "running", { checkpoint: { idx: i + 1 }, step: `${i + 1}/${sources.length}` });
          }
        }
        ctx.logger.info(`\n完成: +${totalAdded} (${totalSkipped} 条无新增)`);
        ctx.output.platform({ type: "kb.curated", added: totalAdded, skipped: totalSkipped, sources: sources.length });
        return { success: true, data: { sources: sources.length, added: totalAdded, skipped: totalSkipped } };
      }

      return { success: false, error: `未知 action: ${action}` };
    } finally {
      _status = "idle";
    }
  },
};
export default knowledgeBasePlugin;
function sanitize(s: string): string { return s.replace(/[<>:"/\\|?*]/g, "_").slice(0, 60); }
