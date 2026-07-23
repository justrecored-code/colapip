import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["CipherTalk-main/**", "wechat-ai-assistant-main/**", "node_modules/**"],
  },
});
