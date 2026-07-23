// ============================================================================
// Shared Tool: sleep — wait for specified seconds
// ============================================================================

import { Type } from "@sinclair/typebox";

export const sleep = {
  name: "sleep",
  label: "等待",
  description: "等待指定秒数（最大 120s）。用于限流后延迟重试。",
  parameters: Type.Object({ seconds: Type.Number() }),
  execute: async (_tid: string, raw: unknown) => {
    const { seconds } = raw as { seconds: number };
    await new Promise(r => setTimeout(r, Math.min(seconds, 120) * 1000));
    return { content: [{ type: "text" as const, text: `已等待 ${seconds} 秒` }], details: {} };
  },
};
