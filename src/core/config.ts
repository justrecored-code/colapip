// ============================================================================
// Core Config — single source of truth for all platform settings
// ============================================================================

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

// Platform root = project root (2 levels up from src/core/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const PLUGINS_DIR = path.join(ROOT, "plugins");
export const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const LOGS_DIR = path.join(ROOT, "logs");
export const SKILLS_DIR = path.join(ROOT, "src", "platform-skills");
export const DB_PATH = path.join(ROOT, "db", "platform.db");

// ============================================================================
// Types
// ============================================================================

export interface PlatformConfig {
  llm: {
    adapter: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  dashboard: {
    port: number;
    host: string;
  };
}

// ============================================================================
// Load
// ============================================================================

let _config: PlatformConfig | null = null;

export function loadConfig(): PlatformConfig {
  if (_config) return _config;

  // platform.json (required)
  const configPath = path.join(ROOT, "config", "platform.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `platform.json not found at ${configPath}. Copy platform.example.json and configure.`
    );
  }
  const fileConfig: Partial<PlatformConfig> = fs.readJSONSync(configPath);

  // Defaults
  _config = {
    llm: {
      adapter: fileConfig.llm?.adapter ?? "openai-compatible",
      baseUrl: fileConfig.llm?.baseUrl ?? "http://127.0.0.1:12315/v1",
      model: fileConfig.llm?.model ?? "gemma4-26b",
      apiKey: fileConfig.llm?.apiKey ?? undefined,
    },
    dashboard: {
      port: fileConfig.dashboard?.port ?? 3000,
      host: fileConfig.dashboard?.host ?? "127.0.0.1",
    },
  };

  return _config;
}

export function getConfig(): PlatformConfig {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}

/** Create a per-task log stream. Format: logs/<name>/<name>-<ts>.log, keep last 10. */
export function createLogStream(name: string, taskId?: string): ReturnType<typeof fs.createWriteStream> {
  const dir = path.join(LOGS_DIR, name);
  fs.ensureDirSync(dir);
  const prefix = name.split("/").pop() || name;
  const old = fs.readdirSync(dir).filter(f => f.startsWith(prefix + "-") && f.endsWith(".log")).sort().reverse();
  for (const f of old.slice(10)) fs.removeSync(path.join(dir, f));
  const id = taskId ? taskId.slice(0, 8) : Date.now().toString(36);
  return fs.createWriteStream(path.join(dir, `${prefix}-${id}-${Date.now()}.log`), { flags: "w" });
}

// Ensure data directories
fs.ensureDirSync(DATA_DIR);
