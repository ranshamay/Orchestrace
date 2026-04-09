import type { LlmFailureType } from '../types.js';

const TIMEOUT_RE = /(timed?\s*out|timeout|etimedout|deadline exceeded|abort(ed)?)/i;
const AUTH_RE = /(unauthorized|forbidden|invalid api key|invalid key|authentication|auth|permission denied|credentials|token expired|\b401\b|\b403\b)/i;
const RATE_LIMIT_RE = /(rate\s*limit|too many requests|quota exceeded|\b429\b|retry later)/i;
const TOOL_SCHEMA_RE = /(invalid tool call|schema|validatetoolcall|missing required|invalid arguments|tool arguments)/i;
const TOOL_RUNTIME_RE = /(tool execution failed|unknown tool|not allowed while mode|blocked command|tool failed)/i;
const VALIDATION_RE = /(validation failed|verification failed|typecheck|tsc|vitest|eslint)/i;
const PROMPT_TOO_LARGE_RE = /(context length|context window|max(imum)? context|too many tokens|prompt too long|request too large|input is too long|token limit exceeded|maximum prompt length|length exceeded)/i;
const PROVIDER_UNRESPONSIVE_RE = /(service unavailable|temporarily unavailable|upstream unavailable|bad gateway|gateway timeout|overloaded|server overloaded|provider unavailable|connection reset|socket hang up|network error|econnreset|eai_again|enotfound|fetch failed|request was aborted)/i;

export class LlmFailureError extends Error {
  readonly failureType: LlmFailureType;
  readonly provider: string;
  readonly model: string;

  constructor(params: {
    provider: string;
    model: string;
    failureType: LlmFailureType;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause ? { cause: params.cause } : undefined);
    this.name = 'LlmFailureError';
    this.failureType = params.failureType;
    this.provider = params.provider;
    this.model = params.model;
  }
}

export function createLlmFailureError(params: {
  provider: string;
  model: string;
  failureType: LlmFailureType;
  message: string;
  cause?: unknown;
}): LlmFailureError {
  return new LlmFailureError(params);
}

export function classifyLlmFailure(input: {
  message?: string;
  stopReason?: string;
  kind?: 'stop-reason' | 'empty-zero-token' | 'empty-text';
}): LlmFailureType {
  if (input.kind === 'empty-zero-token' || input.kind === 'empty-text') {
    return 'empty_response';
  }

  const combined = `${input.stopReason ?? ''}\n${input.message ?? ''}`.trim();
  if (!combined) {
    return 'unknown';
  }

  if (PROMPT_TOO_LARGE_RE.test(combined)) {
    return 'prompt_too_large';
  }

  if (RATE_LIMIT_RE.test(combined)) {
    return 'rate_limit';
  }

  if (AUTH_RE.test(combined)) {
    return 'auth';
  }

  if (TOOL_SCHEMA_RE.test(combined)) {
    return 'tool_schema';
  }

  if (TOOL_RUNTIME_RE.test(combined)) {
    return 'tool_runtime';
  }

  if (VALIDATION_RE.test(combined)) {
    return 'validation';
  }

  if (TIMEOUT_RE.test(combined)) {
    return 'timeout';
  }

  if (PROVIDER_UNRESPONSIVE_RE.test(combined)) {
    return 'provider_unresponsive';
  }

  return 'unknown';
}