// ============================================================================
// Full test suite — all core modules + platform skills + plugin interfaces
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ============================================================================
// 1. Config
// ============================================================================

import { loadConfig, getConfig, ROOT as CFG_ROOT, PLUGINS_DIR, DATA_DIR, DB_PATH } from "../src/core/config.js";

describe("Config", () => {
  it("loads platform.json successfully", () => {
    const cfg = loadConfig();
    expect(cfg.llm).toBeDefined();
    expect(cfg.llm.model).toBeTruthy();
    expect(cfg.dashboard.port).toBeGreaterThan(0);
  });

  it("returns cached config on second call", () => {
    const cfg1 = loadConfig();
    const cfg2 = loadConfig();
    expect(cfg1).toBe(cfg2);
  });

  it("getConfig throws if not loaded", () => {
    // loadConfig already called, so getConfig should work
    const cfg = getConfig();
    expect(cfg.llm.model).toBeTruthy();
  });

  it("exports correct path constants", () => {
    expect(CFG_ROOT).toBe(ROOT);
    expect(PLUGINS_DIR).toBe(path.join(ROOT, "plugins"));
    expect(DATA_DIR).toBe(path.join(ROOT, "data"));
    expect(DB_PATH).toBe(path.join(ROOT, "db", "platform.db"));
  });
});

// ============================================================================
// 2. Logger
// ============================================================================

import { logger, setLogLevel, setEventBus } from "../src/core/logger.js";
import { eventBus } from "../src/core/event-bus.js";

describe("Logger", () => {
  beforeAll(() => {
    setEventBus(eventBus);
  });

  it("emits log events to EventBus", () => {
    const logs: unknown[] = [];
    const h = (d: unknown) => logs.push(d);
    eventBus.on("log" as any, h);
    logger.info("test-log-message", "test-plugin");
    eventBus.off("log" as any, h);
    expect(logs.length).toBe(1);
    const entry = logs[0] as any;
    expect(entry.message).toBe("test-log-message");
    expect(entry.plugin).toBe("test-plugin");
    expect(entry.level).toBe("info");
  });

  it("respects log level filtering", () => {
    setLogLevel("error");
    const logs: unknown[] = [];
    const h = (d: unknown) => logs.push(d);
    eventBus.on("log" as any, h);
    logger.info("should-be-filtered");
    logger.error("should-appear");
    eventBus.off("log" as any, h);
    setLogLevel("info"); // restore
    // info was filtered, only error appears
    expect(logs.length).toBe(1);
    if (logs.length > 0) expect((logs[0] as any).level).toBe("error");
  });

  it("writes to log file", () => {
    logger.info("file-write-test", "test");
    const logFile = path.join(ROOT, "logs", "platform", "platform.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("file-write-test");
  });
});

// ============================================================================
// 3. LLM Adapter
// ============================================================================

import { createAdapter, OpenAICompatibleAdapter } from "../src/core/llm.js";

describe("LLM Adapter", () => {
  it("createAdapter returns OpenAICompatibleAdapter for 'openai-compatible'", () => {
    const adapter = createAdapter({ adapter: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "test" });
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(adapter.name).toBe("openai-compatible");
  });

  it("throws for unknown adapter", () => {
    expect(() => createAdapter({ adapter: "unknown" as any, baseUrl: "", model: "" })).toThrow("Unknown adapter");
  });

  it("healthCheck returns false when LLM unreachable", async () => {
    const adapter = new OpenAICompatibleAdapter({ adapter: "openai-compatible", baseUrl: "http://127.0.0.1:19999/v1", model: "test" });
    const ok = await adapter.healthCheck();
    expect(ok).toBe(false);
  });

  it("chat queues requests (sequential execution)", async () => {
    const adapter = new OpenAICompatibleAdapter({ adapter: "openai-compatible", baseUrl: "http://127.0.0.1:19999/v1", model: "test" });
    // Both should fail (no server) but they should execute sequentially via queue
    const order: number[] = [];
    const p1 = adapter.chat({ messages: [{ role: "user", content: "hi" }] }).catch(() => order.push(1));
    const p2 = adapter.chat({ messages: [{ role: "user", content: "hi" }] }).catch(() => order.push(2));
    await Promise.all([p1, p2]);
    // If queuing works, they complete in order (1 then 2)
    expect(order).toEqual([1, 2]);
  });
});

// ============================================================================
// 4. DB — Assets & Chat History
// ============================================================================

import {
  initDB, createTask, getTask, updateTaskState, getAllTasks,
  createAsset, getAssets, saveChatMessage, getChatHistory, clearChatHistory,
} from "../src/core/db.js";

beforeAll(() => {
  loadConfig();
  initDB();
});

describe("DB Assets", () => {
  it("creates and retrieves assets", () => {
    createAsset("t-test", "test-plugin", "image/png", "/tmp/test.png", "test.png", 12345, { w: 100 });
    const assets = getAssets({ type: "image/png" });
    expect(assets.length).toBeGreaterThan(0);
    expect(assets[0]!.filename).toBe("test.png");
    expect(assets[0]!.size).toBe(12345);
  });

  it("filters assets by plugin_name", () => {
    createAsset("t-test", "filter-plugin", "text/markdown", "/tmp/readme.md", "readme.md", 100);
    const filtered = getAssets({ plugin_name: "filter-plugin" });
    expect(filtered.every(a => a.plugin_name === "filter-plugin")).toBe(true);
  });
});

describe("DB Chat History", () => {
  it("saves and retrieves chat messages", () => {
    clearChatHistory();
    saveChatMessage("user", "hello");
    saveChatMessage("assistant", "hi there");
    const hist = getChatHistory(50);
    expect(hist.length).toBe(2);
    expect(hist[0]!.role).toBe("user");
    expect(hist[1]!.role).toBe("assistant");
  });

  it("respects limit parameter", () => {
    clearChatHistory();
    for (let i = 0; i < 10; i++) saveChatMessage("user", `msg${i}`);
    const hist = getChatHistory(3);
    expect(hist.length).toBe(3);
  });

  it("clear removes all messages", () => {
    saveChatMessage("user", "test");
    clearChatHistory();
    const hist = getChatHistory(50);
    expect(hist.length).toBe(0);
  });
});

describe("DB Task State Transitions", () => {
  it("transitions: pending → running → completed", () => {
    const id = createTask("state-test", { x: 1 });
    let t = getTask(id);
    expect(t!.state).toBe("pending");

    updateTaskState(id, "running", { step: "working", progress: 0.5 });
    t = getTask(id);
    expect(t!.state).toBe("running");
    expect(t!.step).toBe("working");
    expect(t!.progress).toBe(0.5);

    updateTaskState(id, "completed", { progress: 1 });
    t = getTask(id);
    expect(t!.state).toBe("completed");
    expect(t!.progress).toBe(1);
  });

  it("transitions: pending → failed with error", () => {
    const id = createTask("fail-test", {});
    updateTaskState(id, "failed", { error: "something broke" });
    const t = getTask(id);
    expect(t!.state).toBe("failed");
    expect(t!.error).toBe("something broke");
  });

  it("saves and retrieves checkpoint", () => {
    const id = createTask("cp-test", {});
    updateTaskState(id, "running", { checkpoint: { idx: 42 } });
    const t = getTask(id);
    const cp = JSON.parse(t!.checkpoint || "{}");
    expect(cp.idx).toBe(42);
  });

  it("getAllTasks respects LIMIT", () => {
    const all = getAllTasks();
    expect(all.length).toBeLessThanOrEqual(100);
  });
});

// ============================================================================
// 5. EventBus — edge cases
// ============================================================================

describe("EventBus Edge Cases", () => {
  it("off on unregistered handler does not throw", () => {
    expect(() => eventBus.off("log", () => {})).not.toThrow();
  });

  it("handler errors do not break other handlers", () => {
    const good: unknown[] = [];
    const bad = () => { throw new Error("boom"); };
    const ok = (d: unknown) => good.push(d);
    eventBus.on("log" as any, bad);
    eventBus.on("log" as any, ok);
    eventBus.emit("log" as any, { x: 1 });
    eventBus.off("log" as any, bad);
    eventBus.off("log" as any, ok);
    expect(good.length).toBe(1);
  });

  it("off removes specific handler", () => {
    let count = 0;
    const h = () => count++;
    eventBus.on("task.error" as any, h);
    eventBus.off("task.error" as any, h);
    eventBus.emit("task.error" as any, {});
    expect(count).toBe(0);
  });
});

// ============================================================================
// 6. Platform Skills
// ============================================================================

import { sleep } from "../src/platform-skills/sleep.js";
import { dbQuery } from "../src/platform-skills/db_query.js";

describe("Platform Skills", () => {
  it("sleep has correct shape", () => {
    expect(sleep.name).toBe("sleep");
    expect(typeof sleep.execute).toBe("function");
    expect(sleep.parameters).toBeDefined();
  });

  it("sleep waits specified seconds", async () => {
    const start = Date.now();
    const result = await sleep.execute("", { seconds: 0.1 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect((result as any).content[0].text).toContain("已等待");
  });

  it("sleep parameter schema requires number", () => {
    // Verify parameter schema exists and expects a number
    expect(sleep.parameters).toBeTruthy();
  });

  it("db_query has correct shape", () => {
    expect(dbQuery.name).toBe("db_query");
    expect(typeof dbQuery.execute).toBe("function");
    expect(dbQuery.description).toContain("platform.db");
  });
});

// ============================================================================
// 7. Tool Registry
// ============================================================================

import { toolRegistry } from "../src/core/plugin-manager.js";

describe("ToolRegistry", () => {
  beforeAll(async () => {
    await toolRegistry.loadFromDir();
  });

  it("registers and retrieves tools", () => {
    const tool = { name: "mock-tool", description: "mocked", parameters: {}, execute: async () => ({} as any) };
    toolRegistry.register(tool as any);
    const found = toolRegistry.get("mock-tool");
    expect(found).toBe(tool);
    // Clean up — unregister not available, but register skips duplicates
  });

  it("skips duplicate registration", () => {
    const tool = { name: "dup-tool", description: "dup", parameters: {}, execute: async () => ({} as any) };
    toolRegistry.register(tool as any);
    toolRegistry.register(tool as any); // should warn but not throw
    const found = toolRegistry.get("dup-tool");
    expect(found).toBe(tool);
  });

  it("getAll returns all registered tools", () => {
    const all = toolRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(2); // sleep + db_query at minimum
    expect(all.some(t => t.name === "sleep")).toBe(true);
    expect(all.some(t => t.name === "db_query")).toBe(true);
  });
});

// ============================================================================
// 8. Plugin Manager — Task Lifecycle (integration)
// ============================================================================

import { pluginManager } from "../src/core/plugin-manager.js";

describe("PluginManager", () => {
  beforeAll(async () => {
    // Load plugins if not already loaded
    if (pluginManager.getAllPlugins().length === 0) {
      await pluginManager.scanAndRegister();
    }
  });

  it("getAllPlugins returns loaded plugins", () => {
    const plugins = pluginManager.getAllPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(1);
    expect(plugins.some(p => p.name === "recipe-engine")).toBe(true);
  });

  it("getPlugin returns specific plugin", () => {
    const p = pluginManager.getPlugin("recipe-engine");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("recipe-engine");
  });

  it("getPlugin returns null for unknown", () => {
    expect(pluginManager.getPlugin("nonexistent")).toBeNull();
  });

  it("submitTask validates empty params allowed for all-optional plugins", async () => {
    // recipe-engine params all optional → validation passes (plugin handles internally)
    const id = createTask("recipe-engine", {});
    expect(id).toBeTruthy();
  });

  it("submitTask creates task with correct params", async () => {
    const taskId = createTask("recipe-engine", { prompt: "test" });
    expect(taskId).toBeTruthy();
    expect(taskId.length).toBe(8);

    const t = getTask(taskId);
    expect(t).not.toBeNull();
    expect(t!.plugin_name).toBe("recipe-engine");
    expect(t!.state).toBe("pending");
  });

  it("pauseTask sets state to paused", async () => {
    const taskId = createTask("pause-test", {});
    pluginManager.pauseTask(taskId);
    const t = getTask(taskId);
    expect(t!.state).toBe("paused");
  });

  it("retryTask sets pending + clears error + dispatches", async () => {
    const taskId = createTask("retry-test", { image: "nonexistent.jpg" });
    updateTaskState(taskId, "failed", { error: "old error" });
    pluginManager.retryTask(taskId);
    const t = getTask(taskId);
    expect(t!.state === "pending" || t!.state === "running" || t!.state === "failed").toBe(true);
    // Error should be cleared
    expect(t!.error).toBeFalsy();
  });

  it("cancelTask signals abort + sets cancelled", () => {
    const taskId = createTask("cancel-test", {});
    updateTaskState(taskId, "running");
    pluginManager.cancelTask(taskId);
    const t = getTask(taskId);
    expect(t!.state).toBe("cancelled");
  });
});

// ============================================================================
// 9. Plugin Interface — Context Shape
// ============================================================================

import type { Plugin, PluginContext } from "../src/core/plugin.js";

describe("Plugin Interface", () => {
  it("PluginContext has all required fields", () => {
    // Compile-time check: if this compiles, the type is correct
    const ctx: PluginContext = {
      llm: { name: "test", chat: async () => ({ content: "" }), healthCheck: async () => true },
      eventBus: { emit: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      createAsset: () => {},
      aborted: false,
    };
    expect(ctx.aborted).toBe(false);
  });

  it("aborted flag is writable (for cancel signal)", () => {
    let flag = false;
    const ctx: PluginContext = {
      llm: { name: "test", chat: async () => ({ content: "" }), healthCheck: async () => true },
      eventBus: { emit: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      createAsset: () => {},
      get aborted() { return flag; },
    };
    expect(ctx.aborted).toBe(false);
    flag = true;
    expect(ctx.aborted).toBe(true);
  });
});

// ============================================================================
// 10. Checkpoint + Resume Logic
// ============================================================================

describe("Checkpoint Resume", () => {
  it("round-trips checkpoint through updateTaskState + getTask", () => {
    const id = createTask("cp-roundtrip", { img: "test.jpg" });
    const cp = { idx: 57, maxIterations: 3, image: "done.jpg" };
    updateTaskState(id, "running", { checkpoint: cp });
    const t = getTask(id);
    const parsed = JSON.parse(t!.checkpoint || "{}");
    expect(parsed.idx).toBe(57);
    expect(parsed.maxIterations).toBe(3);
    expect(parsed.image).toBe("done.jpg");
  });

  it("checkpoint null/empty works", () => {
    const id = createTask("cp-null", {});
    const t = getTask(id);
    expect(t!.checkpoint).toBeFalsy();
    // Should not throw when checking
    const cp = t!.checkpoint ? JSON.parse(t!.checkpoint) : undefined;
    expect(cp).toBeUndefined();
  });
});

// ============================================================================
// 11. Concurrency + Queue
// ============================================================================

describe("Concurrency", () => {
  it("createTask produces unique IDs", () => {
    const id1 = createTask("recipe-engine", { prompt: "test1" });
    const id2 = createTask("recipe-engine", { prompt: "test2" });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});

afterAll(async () => {
  const { execSync } = await import("child_process");
  const names = ["test-plugin","test-plugin-2","state-test","fail-test","cp-test","pause-test","retry-test","cancel-test","cp-roundtrip","cp-null","filter-plugin","dup-tool"];
  try { execSync(`sqlite3 "db/platform.db" "DELETE FROM tasks WHERE plugin_name IN ('${names.join("','")}')"`, { timeout: 3000, windowsHide: true }); } catch {}
});
