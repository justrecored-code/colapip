// ============================================================================
// Core module tests
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eventBus } from "../src/core/event-bus.js";
import { loadConfig } from "../src/core/config.js";
import { initDB, createTask, getTask, updateTaskState, getAllTasks } from "../src/core/db.js";

beforeAll(() => {
  loadConfig();
  initDB();
});

// ============================================================================
// EventBus
// ============================================================================

describe("EventBus", () => {
  it("delivers events to handlers", () => {
    const received: unknown[] = [];
    const handler = (d: unknown) => received.push(d);
    eventBus.on("log" as any, handler);
    eventBus.emit("log" as any, { msg: "test" });
    eventBus.off("log" as any, handler);
    expect(received.length).toBe(1);
  });

  it("handles multiple handlers on same event", () => {
    let count = 0;
    const h1 = () => count++;
    const h2 = () => count++;
    eventBus.on("task.progress" as any, h1);
    eventBus.on("task.progress" as any, h2);
    eventBus.emit("task.progress" as any, {});
    expect(count).toBe(2);
    eventBus.off("task.progress" as any, h1);
    eventBus.off("task.progress" as any, h2);
  });

  it("does not throw when no handlers", () => {
    expect(() => eventBus.emit("log" as any, {})).not.toThrow();
  });
});

// ============================================================================
// DB (Task CRUD)
// ============================================================================

describe("Task DB", () => {
  it("creates and reads a task", () => {
    const id = createTask("test-plugin", { key: "value" });
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(0);

    const task = getTask(id);
    expect(task).not.toBeNull();
    expect(task!.plugin_name).toBe("test-plugin");
    expect(task!.state).toBe("pending");
  });

  it("updates task state", () => {
    const id = createTask("test-plugin-2", {});
    updateTaskState(id, "running", { step: "processing", progress: 0.5 });
    const task = getTask(id);
    expect(task!.state).toBe("running");
    expect(task!.step).toBe("processing");
    expect(task!.progress).toBe(0.5);
  });

  it("getAllTasks returns tasks", () => {
    const tasks = getAllTasks();
    expect(tasks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// State Machine
afterAll(async () => {
  const { execSync } = await import("child_process");
  try { execSync(`sqlite3 "db/platform.db" "DELETE FROM tasks WHERE plugin_name IN ('test-plugin','test-plugin-2','state-test','fail-test','cp-test','pause-test','retry-test','cancel-test','cp-roundtrip','cp-null')"`, { timeout: 3000, windowsHide: true }); } catch {}
});
