import type { LlmFailureType } from '@orchestrace/provider';

export type SubAgentFailureType = LlmFailureType | 'abort';

export interface ClassifiedSubAgentFailure {
  failureType: SubAgentFailureType;
  recoverable: boolean;
}

const SUBAGENT_ABORT_RE = /(abort(ed)?|aborted by signal|cancelled|canceled)/i;
const SUBAGENT_TIMEOUT_RE = /(timed?\s*out|timeout|etimedout|deadline exceeded)/i;
const SUBAGENT_RATE_LIMIT_RE = /(rate\s*limit|too many requests|quota exceeded|\b429\b|retry later)/i;
const SUBAGENT_AUTH_RE = /(unauthorized|forbidden|invalid api key|invalid key|authentication|auth|permission denied|credentials|token expired|\b401\b|\b403\b)/i;
const SUBAGENT_TOOL_SCHEMA_RE = /(invalid tool call|schema|validatetoolcall|missing required|invalid arguments|tool arguments)/i;
const SUBAGENT_TOOL_RUNTIME_RE = /(tool execution failed|unknown tool|not allowed while mode|blocked command|tool failed)/i;
const SUBAGENT_VALIDATION_RE = /(validation failed|verification failed|typecheck|tsc|vitest|eslint)/i;

export function classifySubAgentFailure(err: unknown): ClassifiedSubAgentFailure {
  if (isAbortSignalError(err)) {
    return { failureType: 'abort', recoverable: true };
  }

  const combined = `${asString((err as { name?: unknown })?.name)}\n${errorMsg(err)}`;

  if (SUBAGENT_ABORT_RE.test(combined)) {
    return { failureType: 'abort', recoverable: true };
  }

  if (SUBAGENT_TIMEOUT_RE.test(combined)) {
    return { failureType: 'timeout', recoverable: true };
  }

  if (SUBAGENT_RATE_LIMIT_RE.test(combined)) {
    return { failureType: 'rate_limit', recoverable: true };
  }

  if (SUBAGENT_AUTH_RE.test(combined)) {
    return { failureType: 'auth', recoverable: false };
  }

  if (SUBAGENT_TOOL_SCHEMA_RE.test(combined)) {
    return { failureType: 'tool_schema', recoverable: false };
  }

  if (SUBAGENT_TOOL_RUNTIME_RE.test(combined)) {
    return { failureType: 'tool_runtime', recoverable: false };
  }

  if (SUBAGENT_VALIDATION_RE.test(combined)) {
    return { failureType: 'validation', recoverable: false };
  }

  return { failureType: 'unknown', recoverable: false };
}

export function isRetryableSubAgentFailure(err: unknown): boolean {
  return classifySubAgentFailure(err).recoverable;
}

function isAbortSignalError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const record = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = asString(record.name).toLowerCase();
  const code = asString(record.code).toLowerCase();
  const message = asString(record.message);

  return name === 'aborterror'
    || code === 'abort_err'
    || /abort(ed)? by signal/i.test(message);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}