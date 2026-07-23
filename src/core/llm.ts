// ============================================================================
// LLM Adapter — OpenAI-compatible with request queuing
// ============================================================================

import { getConfig, loadConfig, type PlatformConfig } from "./config.js";
import { logger } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

interface ChatParams {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

interface ChatResult {
  content: string;
  thinking?: string;     // reasoning_content — the model's internal thought process
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
}

// ============================================================================
// Adapter interface
// ============================================================================

export interface LLMAdapter {
  name: string;
  chat(params: ChatParams): Promise<ChatResult>;
  healthCheck(): Promise<boolean>;
}

// ============================================================================
// OpenAI-compatible adapter with request queue
// ============================================================================

export class OpenAICompatibleAdapter implements LLMAdapter {
  name = "openai-compatible";
  private config: PlatformConfig["llm"];
  private pending: Promise<void> = Promise.resolve();
  private _queueDepth = 0;
  private _processing = false;

  constructor(config: PlatformConfig["llm"]) {
    this.config = config;
  }

  get queueDepth(): number { return this._queueDepth; }
  get isProcessing(): boolean { return this._processing; }

  async chat(params: ChatParams): Promise<ChatResult> {
    logger.info(`LLM 排队 (队列: ${this._queueDepth})`, "llm");
    this._queueDepth++;
    const prev = this.pending;
    let release: () => void;
    this.pending = new Promise(r => { release = r; });
    await prev;
    this._queueDepth--;
    this._processing = true;

    try {
      const result = await this._doChat(params);
      logger.info(`LLM 完成 (tokens: ${result.usage?.totalTokens || "?"})`, "llm");
      // Log full response (content + thinking) for debugging
      if (result.thinking) logger.info(`[LLM 思考] ${result.thinking.slice(0, 2000)}`, "llm");
      logger.info(`[LLM 回复] ${result.content.slice(0, 4000)}`, "llm");
      return result;
    } finally {
      this._processing = false;
      release!();
    }
  }

  private async _doChat(params: ChatParams): Promise<ChatResult> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`LLM request failed: ${resp.status} ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const content = (msg.content || "").trim();
    const thinking = (msg.reasoning_content || "").trim();
    return {
      content: content || thinking,  // fallback: if content empty, use reasoning
      thinking: thinking || undefined,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      finishReason: choice?.finish_reason,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let _adapter: LLMAdapter | null = null;

export function createAdapter(config?: PlatformConfig["llm"]): LLMAdapter {
  const cfg = config ?? getConfig().llm;
  if (cfg.adapter === "openai-compatible") {
    return new OpenAICompatibleAdapter(cfg);
  }
  throw new Error(`Unknown adapter: ${cfg.adapter}`);
}

export function getPlatformLLM(): LLMAdapter {
  if (!_adapter) {
    _adapter = createAdapter();
    logger.info("LLM Adapter initialized", "core");
  }
  return _adapter;
}

// ============================================================================
// Agent model factory — for plugins that create their own Agent instances
// ============================================================================

/**
 * Build a pi-agent-core model descriptor from platform config.
 * Plugins that need multi-turn stateful workflows with per-task custom tools
 * should create their own Agent using this model descriptor.
 *
 * Short stateless interactions should use ctx.output.agent("dashboard", ...) instead.
 */
export function createAgentModel(opts?: { name?: string; supportsImages?: boolean }): any {
  const config = loadConfig();
  return {
    id: config.llm.model,
    name: opts?.name ?? "Platform LLM",
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: config.llm.baseUrl,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "high" },
    input: opts?.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    compat: opts?.supportsImages ? { supportsThinking: true, supportsImages: true } : {},
  };
}
