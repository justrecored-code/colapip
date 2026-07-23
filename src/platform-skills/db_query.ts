// ============================================================================
// Shared Tool: db_query — execute SQL on any SQLite database (better-sqlite3)
// ============================================================================

import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import path from "path";
import { ROOT } from "../core/config.js";

const DEFAULT_DB = path.join(ROOT, "db", "platform.db");

export const dbQuery = {
  name: "db_query",
  label: "查询数据库",
  description: `执行 SQL 查询。默认查平台数据库 db/platform.db。可指定 db 参数查其他 SQLite 库。
平台数据库表结构:
- tasks(id, plugin_name, params, state, progress, step, checkpoint, error, created_at, updated_at)
- assets(id, task_id, plugin_name, type, path, filename, size, metadata, created_at)
- chat_history(id, role, content, source, created_at)`,
  parameters: Type.Object({ sql: Type.String(), db: Type.Optional(Type.String()) }),
  execute: async (_tid: string, raw: unknown) => {
    const { sql, db } = raw as { sql: string; db?: string };

    // Resolve and validate db path — reject paths outside project root
    const resolved = path.resolve(db || DEFAULT_DB);
    const allowedRoot = path.resolve(ROOT);
    if (!resolved.startsWith(allowedRoot + path.sep)) {
      return { content: [{ type: "text" as const, text: "不允许的路径" }], details: {} };
    }

    const dbInst = new Database(resolved, { readonly: false });
    dbInst.pragma("busy_timeout = 5000");

    try {
      const trimmed = sql.trim();

      // SELECT-like queries: return results
      if (/^(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(trimmed)) {
        const rows = dbInst.prepare(trimmed).all();
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "(空)" }], details: {} };
        }
        const cols = Object.keys(rows[0] as object);
        const text = [cols.join("|"), ...rows.map(r => cols.map(c => String((r as Record<string, unknown>)[c] ?? "")).join("|"))].join("\n");
        return { content: [{ type: "text" as const, text }], details: {} };
      }

      // Mutation queries (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP): execute
      const result = dbInst.prepare(trimmed).run();
      return { content: [{ type: "text" as const, text: `完成，影响 ${result.changes} 行` }], details: { changes: result.changes } };
    } finally {
      dbInst.close();
    }
  },
};
