import type { LlmFailureType } from '../types.js';

const TIMEOUT_RE = /(timed?\s*out|timeout|etimedout|deadline exceeded|abort(ed)?)/i;
const AUTH_RE = /(unauthorized|forbidden|invalid api key|invalid key|authentication|auth|permission denied|credentials|token expired|\b401\b|\b403\b)/i;
const RATE_LIMIT_RE = /(rate\s*limit|too many requests|quota exceeded|\b429\b|retry later)/i;
const TOOL_SCHEMA_RE = /(invalid tool call|schema|validatetoolcall|missing required|invalid arguments|tool arguments)/i;
const TOOL_CALL_MAPPING_RE = /(no tool call found\s+for\s+function\s+call\s+output|function call output\s+with\s+call_id)/i;
const TOOL_RUNTIME_RE = /(tool execution failed|unknown tool|not allowed while mode|blocked command|tool failed)/i;

const VALIDATION_RE = /(validation failed|verification failed|typecheck|tsc|vitest|eslint)/i;

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

  if (TIMEOUT_RE.test(combined)) {
    return 'timeout';
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

  if (TOOL_CALL_MAPPING_RE.test(combined)) {
    return 'tool_runtime';
  }

  if (TOOL_RUNTIME_RE.test(combined)) {
    return 'tool_runtime';
  }


  if (VALIDATION_RE.test(combined)) {
    return 'validation';
  }

  return 'unknown';
}
