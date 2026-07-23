// ============================================================================
// Structured Logger — file + EventBus dual output
// ============================================================================

import fs from "fs-extra";
import path from "path";
import { ROOT } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogEntry = {
  timestamp: string;
  level: LogLevel;
  plugin?: string;
  message: string;
};

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";
let _eventBus: { emit(event: string, data: unknown): void } | null = null;
const logFile = path.join(ROOT, "logs", "platform", "platform.log");

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setEventBus(bus: { emit(event: string, data: unknown): void }): void {
  _eventBus = bus;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
}

function log(level: LogLevel, plugin: string | undefined, message: string): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: LogEntry = {
    timestamp: ts(),
    level,
    plugin,
    message,
  };

  const prefix = `[${entry.timestamp}] ${level.toUpperCase()}${plugin ? ` [${plugin}]` : ""}`;
  const line = `${prefix} ${message}`;

  switch (level) {
    case "error": console.error(line); break;
    case "warn": console.warn(line); break;
    default: console.log(line); break;
  }

  // Append to file (non-blocking)
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");

  // Push to EventBus for Dashboard
  _eventBus?.emit("log", entry);
}

export const logger = {
  debug: (msg: string, plugin?: string) => log("debug", plugin, msg),
  info: (msg: string, plugin?: string) => log("info", plugin, msg),
  warn: (msg: string, plugin?: string) => log("warn", plugin, msg),
  error: (msg: string, plugin?: string) => log("error", plugin, msg),
};
