// ============================================================================
// Plugin interface + PluginContext + types
// ============================================================================

import type { LLMAdapter } from "./llm.js";

// ============================================================================
// Plugin
// ============================================================================

type PluginStatus = "idle" | "running" | "error" | "paused";

export interface PluginConfig {
  rootDir: string;
  platformLLM: LLMAdapter;
}

interface LLMConfig {
  adapter: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface PluginServices {
  comfyui?: { baseUrl: string };
  tts?: { baseUrl: string };
}

export interface Task {
  id: string;
  pluginName: string;
  params: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Pi Agent tool schema
export interface ToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: unknown; // TypeBox schema
  execute: (taskId: string, params: unknown) => Promise<unknown>;
}

// ============================================================================
// PluginContext — injected by platform at task dispatch
// ============================================================================

export interface PluginContext {
  llm: LLMAdapter;
  eventBus: {
    emit(event: string, data: unknown): void;
  };
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  createAsset(taskId: string, type: string, filePath: string, filename: string, size: number, metadata?: Record<string, unknown>): void;
  /** AbortSignal — plugin should check ctx.aborted in loops and long ops */
  aborted: boolean;
  /** Plugin output — direct to Dashboard or Agent, not via EventBus */
  output: {
    /** Display on Dashboard (WebSocket broadcast), Agent doesn't see */
    platform(data: unknown): void;
    /**
     * Route to an Agent instance.
     * - ctx.output.agent("dashboard", { prompt, replyTo }) → shared platform Agent (short stateless interactions)
     * - Plugins needing multi-turn stateful workflows with per-task custom tools should create
     *   their own Agent instance using platform model config from loadConfig().llm / PluginConfig.
     */
    agent(pluginName: string, data: unknown): void;
  };
}

// ============================================================================
// Plugin interface
// ============================================================================

export interface Plugin {
  name: string;
  version: string;
  description: string;
  usesPiAgent: true;

  llm?: LLMConfig;
  vlm?: LLMConfig;
  services?: PluginServices;

  skills: string[];
  ownSkills: ToolDef[];

  init(config: PluginConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PluginStatus;

  execute(task: Task, ctx: PluginContext): Promise<TaskResult>;
  resume(taskId: string, checkpoint: unknown, ctx: PluginContext): Promise<void>;
}
