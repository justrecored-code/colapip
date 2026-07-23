// ============================================================================
// Error Codes — single source of truth for plugin/platform error classification
// ============================================================================

/** External service unavailable — platform pauses task, can retry on recovery */
export const ERR_SERVICE_DOWN = "ERR_SERVICE_DOWN" as const;

/** Operation timed out — task marked failed */
export const ERR_TIMEOUT = "ERR_TIMEOUT" as const;

/** Authentication/authorization failure — task marked failed */
export const ERR_AUTH = "ERR_AUTH" as const;

/** LLM context window exceeded — platform retries once, then fails */
export const ERR_CONTEXT_LIMIT = "ERR_CONTEXT_LIMIT" as const;

/** Unclassified error — used when no specific code applies */
export const ERR_UNKNOWN = "ERR_UNKNOWN" as const;

/** All error codes as a readonly array — useful for validation */
const ERROR_CODES = [
  ERR_SERVICE_DOWN,
  ERR_TIMEOUT,
  ERR_AUTH,
  ERR_CONTEXT_LIMIT,
  ERR_UNKNOWN,
] as const;

type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Build an error message with a standard error code prefix.
 * Usage: throw new Error(errMsg(ERR_SERVICE_DOWN, "ComfyUI 不可用"));
 */
export function errMsg(code: ErrorCode, detail: string): string {
  return `${code}: ${detail}`;
}
