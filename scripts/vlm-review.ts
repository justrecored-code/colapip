import { loadConfig } from "../src/core/config.js";
import { OpenAICompatibleAdapter } from "../src/core/llm.js";
import fs from "fs-extra";

const c = loadConfig();
const a = new OpenAICompatibleAdapter(c.llm);
const html = fs.readFileSync("plugins/llm-launcher/ui.html", "utf-8");
const r = await a.chat({
  messages: [{
    role: "user" as const,
    content: `你是UI设计师。这是深色主题LLM进程管理面板的HTML/CSS，嵌入在Dashboard的iframe中。分析代码，给出3条具体的视觉优化建议。关注：控件分组、按钮配色、日志区域可读性、状态指示器。每条用中文说明问题+改法。\n\nHTML:\n${html}`,
  }],
  maxTokens: 3000,
});
console.log(r.content || "(空)");
