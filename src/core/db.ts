// ============================================================================
// SQLite wrapper — tasks, assets, chat_history (backed by better-sqlite3)
// ============================================================================

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs-extra";
import path from "path";
import { DB_PATH } from "./config.js";
import { logger } from "./logger.js";

// ============================================================================
// Database singleton
// ============================================================================

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  fs.ensureDirSync(path.dirname(DB_PATH));
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  return _db;
}

/** Expose for platform tools that need raw SQL (e.g. db_query). */
function rawExec(sql: string): string {
  const db = getDb();
  try {
    const rows = db.prepare(sql).all();
    if (rows.length === 0) return "";
    // Render as pipe-delimited text for backward compat
    const cols = Object.keys(rows[0] as object);
    return [cols.join("|"), ...rows.map(r => cols.map(c => String((r as Record<string, unknown>)[c] ?? "")).join("|"))].join("\n");
  } catch {
    // Not a SELECT — run as exec
    db.exec(sql);
    return "";
  }
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  plugin_name TEXT NOT NULL,
  params      TEXT DEFAULT '{}',
  state       TEXT DEFAULT 'pending',
  progress    REAL DEFAULT 0,
  step        TEXT DEFAULT '',
  checkpoint  TEXT DEFAULT '',
  error       TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  type        TEXT NOT NULL,
  path        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  size        INTEGER DEFAULT 0,
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS chat_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT DEFAULT 'dashboard',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);
`;

export function initDB(): void {
  const db = getDb();
  db.exec(SCHEMA);

  // Migration: add source column to chat_history if missing
  const cols = db.pragma("table_info(chat_history)") as Array<{ name: string }>;
  if (!cols.some(c => c.name === "source")) {
    db.exec("ALTER TABLE chat_history ADD COLUMN source TEXT DEFAULT 'dashboard'");
  }

  // Clean up terminal tasks
  db.exec("DELETE FROM tasks WHERE state = 'cancelled'");
  db.exec("DELETE FROM tasks WHERE state = 'completed' AND updated_at < datetime('now','localtime','-7 days')");
  logger.info("DB initialized", "core");
}

// ============================================================================
// Task CRUD
// ============================================================================

export interface TaskRow {
  id: string;
  plugin_name: string;
  params: string;
  state: string;
  progress: number;
  step: string;
  checkpoint: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export function createTask(pluginName: string, params: Record<string, unknown>): string {
  const id = randomUUID().slice(0, 8);
  getDb().prepare("INSERT INTO tasks(id, plugin_name, params) VALUES(?,?,?)")
    .run(id, pluginName, JSON.stringify(params));
  return id;
}

export function getTask(id: string): TaskRow | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ?? null;
}

export function updateTaskState(id: string, state: string, extra?: Record<string, unknown>): void {
  const sets: string[] = ["state = ?", "updated_at = datetime('now','localtime')"];
  const vals: unknown[] = [state];

  if (extra?.progress !== undefined) { sets.push("progress = ?"); vals.push(extra.progress); }
  if (extra?.step !== undefined) { sets.push("step = ?"); vals.push(extra.step); }
  if (extra?.checkpoint !== undefined) { sets.push("checkpoint = ?"); vals.push(JSON.stringify(extra.checkpoint)); }
  if (extra?.error !== undefined) { sets.push("error = ?"); vals.push(extra.error); }

  vals.push(id);
  getDb().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getPendingAndRunningTasks(): TaskRow[] {
  return getDb().prepare("SELECT * FROM tasks WHERE state IN ('pending','running','paused') ORDER BY created_at").all() as TaskRow[];
}

export function getAllTasks(): TaskRow[] {
  return getDb().prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").all() as TaskRow[];
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// ============================================================================
// Chat history
// ============================================================================

export function clearChatHistory(): void {
  getDb().exec("DELETE FROM chat_history");
}

export function saveChatMessage(role: string, content: string, source: string = "dashboard"): void {
  getDb().prepare("INSERT INTO chat_history(role, content, source) VALUES(?,?,?)")
    .run(role, content, source);
}

export function getChatHistory(limit: number = 50): Array<{ role: string; content: string; source: string; created_at: string }> {
  return getDb().prepare("SELECT role, content, source, created_at FROM chat_history ORDER BY id ASC LIMIT ?")
    .all(limit) as Array<{ role: string; content: string; source: string; created_at: string }>;
}

// ============================================================================
// Asset CRUD
// ============================================================================

interface AssetRow {
  id: string; task_id: string; plugin_name: string; type: string;
  path: string; filename: string; size: number; metadata: string; created_at: string;
}

export function createAsset(
  taskId: string, pluginName: string, type: string,
  filePath: string, filename: string, size: number, metadata: Record<string, unknown> = {}
): void {
  const id = randomUUID().slice(0, 12);
  getDb().prepare(
    "INSERT INTO assets(id, task_id, plugin_name, type, path, filename, size, metadata) VALUES(?,?,?,?,?,?,?,?)"
  ).run(id, taskId, pluginName, type, filePath, filename, size, JSON.stringify(metadata));
}

export function getAssets(filters?: { type?: string; plugin_name?: string }): AssetRow[] {
  let sql = "SELECT * FROM assets WHERE 1=1";
  const params: unknown[] = [];
  if (filters?.type) { sql += " AND type = ?"; params.push(filters.type); }
  if (filters?.plugin_name) { sql += " AND plugin_name = ?"; params.push(filters.plugin_name); }
  sql += " ORDER BY created_at DESC LIMIT 200";
  return getDb().prepare(sql).all(...params) as AssetRow[];
}

export function deleteAsset(id: string): void {
  getDb().prepare("DELETE FROM assets WHERE id = ?").run(id);
}

/** Delete all assets belonging to a task. */
function deleteAssetsByTask(taskId: string): void {
  getDb().prepare("DELETE FROM assets WHERE task_id = ?").run(taskId);
}

// ============================================================================
// Plugin DB helper — for plugins that manage their own SQLite databases
// ============================================================================

/**
 * Open a plugin-owned SQLite database with WAL mode + busy timeout.
 * Plugins that need their own database (not the platform DB) should use this
 * instead of shelling out to the sqlite3 CLI.
 */
export function openPluginDB(dbPath: string): Database.Database {
  fs.ensureDirSync(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}
