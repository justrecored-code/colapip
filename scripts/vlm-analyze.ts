import { loadConfig } from "../src/core/config.js";
import { OpenAICompatibleAdapter } from "../src/core/llm.js";
import fs from "fs-extra";

const c = loadConfig();
const a = new OpenAICompatibleAdapter(c.llm);
const b64 = fs.readFileSync("data/temp/tasks-page.png").toString("base64");
console.log("Sending image to VLM...");
const r = await a.chat({
  messages: [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "你是一个UI设计师。看这个任务管理页面截图，列出3条视觉优化建议。布局、色彩、字体。中文回答。" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64," + b64 } }
    ]
  }],
  maxTokens: 600,
});
console.log("--- VLM 分析 ---");
console.log(r.content || "(空)");
