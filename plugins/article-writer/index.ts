/**
 * Article Writer Plugin — 公众号文章写作
 * 基于 Girll-with-Docs: 盘问用户→明确需求→增量记录风格偏好
 * 写作流程参考 https://github.com/zhaodl1983/ai-write-flow (MIT)
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT } from "../../src/core/config.js";
import { createAgentModel } from "../../src/core/llm.js";
import { getChatHistory } from "../../src/core/db.js";
import { Agent } from "@mariozechner/pi-agent-core";
import fs from "fs-extra";
import path from "path";

let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;

const OUTPUT_DIR = path.join(ROOT, "data", "assets", "articles");
const KB_DIR = path.join(ROOT, "data", "knowledge");
const DOCS_PATH = (): string => path.join(_rootDir, "girll-docs.md");

const ANTI_AI_PATTERNS = `
## 反AI味检测规则（来自 ai-write-flow）
- P0(必改): 假深刻/意义拔高、凭空金句、虚构时间地点、排比堆砌
- P1(强烈建议改): 过度书面化、套话("众所周知""总而言之")、空洞过渡
- P2(密度过高时改): 重复结论、过度修饰
原则: 能少动就少动。保留作者语气词、停顿。不主动加金句、比喻。
`;

function loadDocs(): string {
  const p = DOCS_PATH();
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

function saveDocs(content: string): void {
  fs.writeFileSync(DOCS_PATH(), content, "utf-8");
}

function scanSources(topic: string): string {
  const keywords = topic.split(/[,，\s]+/).filter(Boolean).map(k => k.toLowerCase());
  interface Entry { name: string; content: string; match: boolean; }
  const entries: Entry[] = [];

  function scanDir(dir: string, prefix: string): void {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const md = fs.readFileSync(path.join(dir, f), "utf-8");
        const name = `${prefix}${f.replace(".md", "")}`;
        const match = keywords.some(kw => md.toLowerCase().includes(kw) || name.toLowerCase().includes(kw));
        entries.push({ name, content: md.slice(0, 600), match });
      } catch {}
    }
  }

  // Scan knowledge base + own articles
  if (fs.existsSync(KB_DIR)) {
    for (const cat of fs.readdirSync(KB_DIR).filter(d => fs.statSync(path.join(KB_DIR, d)).isDirectory())) {
      scanDir(path.join(KB_DIR, cat), `${cat}/`);
    }
  }
  scanDir(OUTPUT_DIR, "我的文章/");

  // All keyword matches + up to 3 random unrelated entries for creative variety
  const matched = entries.filter(e => e.match);
  const others = entries.filter(e => !e.match).sort(() => Math.random() - 0.5).slice(0, 3);
  const selected = [...matched, ...others].slice(0, 8);
  return selected.length === 0 ? "" : `参考资料 (${selected.length}条, 其中${matched.length}条关键词匹配):\n${selected.map(e => `## ${e.name}\n${e.content}`).join("\n\n")}`;
}

function extractText(msgs: any[]): string {
  return msgs.filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => {
      if (typeof m.content === "string") return [{ type: "text", text: m.content }];
      if (Array.isArray(m.content)) return m.content.filter((b: any) => b.type === "text");
      return [];
    })
    .map((b: any) => b.text).join("\n");
}

const articleWriterPlugin: Plugin = {
  name: "article-writer", version: "1.0.0",
  description: "公众号文章写作——Girll-with-Docs 盘问→大纲→审计→正文→审计→润色",
  usesPiAgent: true, skills: [], ownSkills: [],
  async init(config: PluginConfig) { _rootDir = config.rootDir; fs.ensureDirSync(OUTPUT_DIR); },
  async start() { _status = "idle"; },
  async stop() { _status = "idle"; },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _status = "running";
    const topic = (task.params.topic as string) || "";
    const maxWords = (task.params.maxWords as number) ?? 2000;
    if (!topic) return { success: false, error: "缺少 topic 参数" };

    // Read full chat history — the user's conversation with DashAgent IS the brief
    const chatHistory = getChatHistory();
    const chatContext = chatHistory.map(h => `${h.role === "user" ? "用户" : "助手"}: ${h.content}`).join("\n");

    const userDocs = loadDocs();
    const refText = scanSources(topic);
    const styleGuide = `你是公众号文章写手。你的用户档案:\n${userDocs || "(暂无)"}\n\n写作要求：文章约${maxWords}字。\n\n写作方法论:\n- 先骨架后血肉，大纲确认前不写正文\n- 一个章节只讲一件事\n- 用具体代替抽象，用对话感代替书面腔\n- 每段至少包含一个读者不知道的东西\n- 结尾有行动号召\n${ANTI_AI_PATTERNS}`;

    const fullContext = `${styleGuide}\n\n用户与助手的对话（需求详情）:\n${chatContext}\n\n参考资料:\n${refText || "(无)"}`;

    ctx.logger.info(`开始写作: ${topic}`);

    // Step 0: Update user style docs — outline agent revises girll-docs.md from chat context
    ctx.logger.info("更新风格档案…");
    const docsAgent = new Agent({
      initialState: { systemPrompt: `你是用户风格档案维护者。根据本次对话，修订 girll-docs.md。

现有档案:
${userDocs || "(空——这是第一篇，请创建)"}

修订规则:
- 这是用户风格档案，不是写作笔记。只记录用户的偏好、习惯、术语，不记录本次文章内容。
- 随时修改、增补、优化。不要只追加——如果旧内容过时或不对，就改掉或删除。
- 保持结构清晰：写作风格 / 常用术语 / 内容偏好 / 历史反馈。
- 从对话中提取：语气偏好、喜欢的表达方式、讨厌的表达方式、常用词汇、文章长度偏好、目标读者特征。
- 简洁。每个要点一行。不需要长篇解释。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });
    await docsAgent.prompt(`对话内容:\n${chatContext.slice(0, 8000)}\n\n请修订用户风格档案。输出完整的修订后的档案内容（覆盖旧文件）。`);
    await docsAgent.waitForIdle();
    const newDocs = extractText((docsAgent.state as any).messages ?? []);
    if (newDocs) { saveDocs(newDocs); ctx.logger.info("风格档案已更新"); }

    // Reload updated docs for the rest of the pipeline
    const updatedDocs = loadDocs();
    const updatedStyleGuide = `你是公众号文章写手。你的用户档案:\n${updatedDocs || "(暂无)"}\n\n写作要求：文章约${maxWords}字。\n\n写作方法论:\n- 先骨架后血肉，大纲确认前不写正文\n- 一个章节只讲一件事\n- 用具体代替抽象，用对话感代替书面腔\n- 每段至少包含一个读者不知道的东西\n- 结尾有行动号召\n${ANTI_AI_PATTERNS}`;
    const updatedContext = `${updatedStyleGuide}\n\n用户与助手的对话（需求详情）:\n${chatContext}\n\n参考资料:\n${refText || "(无)"}`;

    // Step 1: Outline
    ctx.logger.info("生成大纲…");
    const outlineAgent = new Agent({
      initialState: { systemPrompt: `${updatedContext}\n\n根据主题、用户需求和参考资料，生成文章大纲。\n格式:\n# 标题(含价值主张)\n## 章节1 (XX字)\n### 要点\n...\n## 写在最后\n每章标注字数。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });
    const auditAgent = new Agent({
      initialState: { systemPrompt: `你是大纲审计员。审查:\n1.标题是否有价值主张？\n2.每章是否独立有增量？\n3.层级是否合理？\n4.是否符合用户风格偏好？\n\n用户风格档案（以此为审查依据）:\n${updatedDocs || "(暂无)"}\n\n输出: 通过 或 需修改+建议。`, model: createAgentModel({ name: "ArticleAuditor" }), thinkingLevel: "medium" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });

    let outline = "";
    for (let r = 1; r <= 3; r++) {
      if (ctx.aborted) return { success: false, error: "cancelled" };
      (outlineAgent.state as any).messages = [];
      await outlineAgent.prompt("请生成文章大纲。");
      await outlineAgent.waitForIdle();
      outline = extractText((outlineAgent.state as any).messages ?? []);
      if (!outline) return { success: false, error: "大纲生成失败" };

      (auditAgent.state as any).messages = [];
      await auditAgent.prompt(`大纲:\n${outline}\n\n审查。`);
      await auditAgent.waitForIdle();
      const ar = extractText((auditAgent.state as any).messages ?? []);
      if (ar.includes("通过") && !ar.includes("需修改")) break;
      ctx.logger.info(`大纲审计第${r}轮: 需修改`);
      if (r >= 3) return { success: false, error: "大纲审计3轮未通过" };
    }

    // Step 2: Body
    ctx.logger.info("撰写正文…");
    const bodyAgent = new Agent({
      initialState: { systemPrompt: `${updatedContext}\n\n根据大纲撰写正文。每段有信息增量，用具体代替抽象，对话感。禁止假深刻、金句、排比。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });
    const bodyAudit = new Agent({
      initialState: { systemPrompt: `正文审计。审查:\n1.信息密度是否足够？\n2.是否有具体案例支撑？\n3.是否存在AI腔（假深刻、金句、排比堆砌）？\n4.是否匹配用户风格偏好？\n\n用户风格档案（以此为审查依据）:\n${updatedDocs || "(暂无)"}\n\n输出: 通过 或 需修改+位置。`, model: createAgentModel({ name: "ArticleAuditor" }), thinkingLevel: "medium" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });

    let article = "";
    for (let r = 1; r <= 3; r++) {
      if (ctx.aborted) return { success: false, error: "cancelled" };
      (bodyAgent.state as any).messages = [];
      await bodyAgent.prompt(`大纲:\n${outline}\n\n撰写完整正文。`);
      await bodyAgent.waitForIdle();
      article = extractText((bodyAgent.state as any).messages ?? []);
      if (!article) return { success: false, error: "正文生成失败" };

      (bodyAudit.state as any).messages = [];
      await bodyAudit.prompt(`正文:\n${article}\n\n审查。`);
      await bodyAudit.waitForIdle();
      const ar = extractText((bodyAudit.state as any).messages ?? []);
      if (ar.includes("通过") && !ar.includes("需修改")) break;
      if (r >= 3) return { success: false, error: "正文审计3轮未通过" };
    }

    // Step 3: Polish + image suggestions
    const polishAgent = new Agent({
      initialState: { systemPrompt: `润色文章，添加图片建议。不修改内容，只在合适位置插入:\n[插入图片: 描述]\n\n每##章节至少1张。信息密度高处配图表。步骤配截图。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "low" },
      toolExecution: "sequential", getApiKey: async () => "not-needed",
    });
    await polishAgent.prompt(`文章:\n${article}\n\n添加图片建议。`);
    await polishAgent.waitForIdle();
    const polished = extractText((polishAgent.state as any).messages ?? []);
    if (!polished) return { success: false, error: "润色失败" };

    // Save
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = topic.replace(/[<>:"/\\|?*【】《》（）！，。、；：？！…—\n\r\[\]]/g, "_").replace(/_{2,}/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "untitled";
    const fn = `${dateStr}-${slug}.md`;
    const fp = path.join(OUTPUT_DIR, fn);
    const yamlSafe = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
    const finalMd = `---\ntitle: "${yamlSafe(topic)}"\ndate: ${dateStr}\nmaxWords: ${maxWords}\n---\n\n${polished}`;
    try {
      fs.writeFileSync(fp, finalMd, "utf-8");
      ctx.createAsset(task.id, "text/markdown", fp, fn, fs.statSync(fp).size, { topic, maxWords });
      ctx.logger.info(`文章已保存: ${fp}`);
    } catch (e) {
      ctx.logger.error(`保存失败: ${(e as Error).message}`);
      return { success: false, error: `保存失败: ${(e as Error).message}` };
    }

    _status = "idle";
    return { success: true, data: { path: fp, slug } };
  },

};
export default articleWriterPlugin;
