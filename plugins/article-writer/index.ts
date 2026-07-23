/**
 * Article Writer Plugin — 公众号文章写作
 * 基于 Girll-with-Docs: 盘问用户→明确需求→增量记录风格偏好
 * 写作流程参考 https://github.com/zhaodl1983/ai-write-flow (MIT)
 */
import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import { ROOT } from "../../src/core/config.js";
import { createAgentModel } from "../../src/core/llm.js";
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

function updateDocs(newObservations: string): void {
  if (!newObservations.trim()) return;
  const p = DOCS_PATH();
  let content = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  content += `\n## ${new Date().toISOString().slice(0, 10)}\n${newObservations}\n`;
  fs.writeFileSync(p, content, "utf-8");
}

function scanKnowledge(topic: string, dirs: string): string {
  const result: string[] = [];
  const keywords = topic.split(/[,，\s]+/).filter(Boolean);
  const cats = dirs === "all"
    ? fs.readdirSync(KB_DIR).filter(d => fs.statSync(path.join(KB_DIR, d)).isDirectory())
    : dirs.split(",").map(s => s.trim());
  for (const cat of cats) {
    const catDir = path.join(KB_DIR, cat);
    if (!fs.existsSync(catDir)) continue;
    for (const f of fs.readdirSync(catDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const md = fs.readFileSync(path.join(catDir, f), "utf-8");
        if (keywords.some(kw => md.includes(kw))) result.push(`## ${cat}/${f.replace(".md", "")}\n${md.slice(0, 600)}`);
      } catch {}
    }
  }
  return result.slice(0, 8).join("\n\n");
}

function extractText(msgs: any[]): string {
  return msgs.filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "text") : [])
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
    const action = (task.params.action as string) || "write";
    const topic = (task.params.topic as string) || "";
    const answers = (task.params.answers as string) || "";
    const style = (task.params.style as string) || "公众号长文";
    const refDirs = (task.params.ref_dirs as string) || "all";
    if (!topic) return { success: false, error: "缺少 topic 参数" };

    const userDocs = loadDocs();
    const refText = scanKnowledge(topic, refDirs);
    const styleGuide = `你是公众号文章写手。你的用户档案:\n${userDocs || "(暂无——这将是你的第一篇，请通过提问多了解用户偏好)"}\n\n写作方法论:\n- 先骨架后血肉，大纲确认前不写正文\n- 一个章节只讲一件事\n- 用具体代替抽象，用对话感代替书面腔\n- 每段至少包含一个读者不知道的东西\n- 结尾有行动号召\n${ANTI_AI_PATTERNS}`;

    // ── CLARIFY: generate questions to understand user needs ──
    if (action === "clarify") {
      const qAgent = new Agent({
        initialState: { systemPrompt: `${styleGuide}\n\n你是内容需求分析师。根据用户主题和已有偏好档案，生成5-10个盘问问题，帮用户理清自己真正想要什么内容。\n问题应覆盖：目标读者、文章调性、核心观点、禁忌话题、希望读者读完感受到什么。\n已有偏好档案中已明确的不要再问。\n\n输出格式：每行一个问题，编号。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
        toolExecution: "sequential", getApiKey: async () => "not-needed",
      });
      await qAgent.prompt(`主题: ${topic}\n风格: ${style}\n参考资料:\n${refText || "(无)"}\n\n请生成盘问问题。`);
      await qAgent.waitForIdle();
      const questions = extractText((qAgent.state as any).messages ?? []);
      ctx.output.platform({ type: "article.clarify", topic, questions });
      _status = "idle";
      return { success: true, data: { questions, hint: "回答这些问题后，提交 write 任务，将答案填入 answers 参数" } };
    }

    // ── WRITE: full pipeline with answers ──
    if (action === "write") {
      if (!answers) return { success: false, error: "请先运行 clarify 获取问题，回答后填入 answers 参数。或直接在 answers 中描述你的需求。" };
      ctx.logger.info(`开始写作: ${topic}`);

      const fullContext = `${styleGuide}\n\n用户对主题的回答:\n${answers}\n\n参考资料:\n${refText || "(无)"}`;

      // Step 1: Outline
      ctx.logger.info("生成大纲…");
      const outlineAgent = new Agent({
        initialState: { systemPrompt: `${fullContext}\n\n根据主题、用户回答和参考资料，生成文章大纲。\n格式:\n# 标题(含价值主张)\n## 章节1 (XX字)\n### 要点\n...\n## 写在最后\n每章标注字数。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
        toolExecution: "sequential", getApiKey: async () => "not-needed",
      });
      const auditAgent = new Agent({
        initialState: { systemPrompt: `你是大纲审计员。审查:\n1.标题是否有价值主张？\n2.每章是否独立有增量？\n3.层级是否合理？\n4.是否符合用户风格偏好？\n输出: 通过 或 需修改+建议。`, model: createAgentModel({ name: "ArticleAuditor" }), thinkingLevel: "medium" },
        toolExecution: "sequential", getApiKey: async () => "not-needed",
      });

      let outline = "";
      for (let r = 1; r <= 3; r++) {
        if (ctx.aborted) return { success: false, error: "cancelled" };
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
        initialState: { systemPrompt: `${fullContext}\n\n根据大纲撰写正文。每段有信息增量，用具体代替抽象，对话感。禁止假深刻、金句、排比。`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "medium" },
        toolExecution: "sequential", getApiKey: async () => "not-needed",
      });
      const bodyAudit = new Agent({
        initialState: { systemPrompt: `正文审计: 信息密度？具体案例？AI腔？用户风格匹配？输出: 通过 或 需修改+位置。`, model: createAgentModel({ name: "ArticleAuditor" }), thinkingLevel: "medium" },
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
      const slug = topic.replace(/[<>:"/\\|?*]/g, "_").slice(0, 40);
      const fn = `${dateStr}-${slug}.md`;
      const fp = path.join(OUTPUT_DIR, fn);
      const finalMd = `---\ntitle: ${topic}\nstyle: ${style}\ndate: ${dateStr}\n---\n\n${polished}`;
      fs.writeFileSync(fp, finalMd, "utf-8");
      ctx.createAsset(task.id, "text/markdown", fp, fn, fs.statSync(fp).size, { topic, style });

      // Update user docs with learnings from this session
      const summaryAgent = new Agent({
        initialState: { systemPrompt: `根据本次写作过程，总结用户的偏好。输出2-3句简洁观察，格式:\n- 写作风格: xxx\n- 常用术语: xxx\n- 其他: xxx`, model: createAgentModel({ name: "ArticleWriter" }), thinkingLevel: "low" },
        toolExecution: "sequential", getApiKey: async () => "not-needed",
      });
      await summaryAgent.prompt(`用户对主题"${topic}"的回答:\n${answers}\n\n生成的文章大纲:\n${outline.slice(0, 500)}\n\n请总结用户偏好。`);
      await summaryAgent.waitForIdle();
      const observations = extractText((summaryAgent.state as any).messages ?? []);
      if (observations) updateDocs(observations);

      ctx.logger.info(`文章已保存: ${fp}`);
      _status = "idle";
      return { success: true, data: { path: fp, slug } };
    }

    return { success: false, error: `未知 action: ${action}` };
  },

  async resume() {},
};
export default articleWriterPlugin;
