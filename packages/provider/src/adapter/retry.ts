import type { LlmFailureType } from '../types.js';

const DEFAULT_EMPTY_RESPONSE_RETRIES = 1;
const DEFAULT_TRANSIENT_REQUEST_RETRIES = 1;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 800;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 8_000;
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function resolveEmptyResponseRetries(): number {
  const raw = process.env.ORCHESTRACE_EMPTY_RESPONSE_RETRIES;
  if (!raw) {
    return DEFAULT_EMPTY_RESPONSE_RETRIES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EMPTY_RESPONSE_RETRIES;
  }

  return parsed;
}

export function resolveTransientRequestRetries(): number {
  const raw = process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS;
  if (!raw) {
    return DEFAULT_TRANSIENT_REQUEST_RETRIES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TRANSIENT_REQUEST_RETRIES;
  }

  return parsed;
}

export function shouldRetryTransientRequestFailure(params: {
  failureType: LlmFailureType;
  mappedMessage: string;
  error: unknown;
}): boolean {
  const mappedMessage = params.mappedMessage.toLowerCase();

  if (mappedMessage.includes('request aborted before completion')) {
    return false;
  }

  if (params.failureType === 'timeout' || params.failureType === 'rate_limit') {
    return true;
  }

  if (!(params.error instanceof Error)) {
    return false;
  }

  const errorRecord = params.error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };

  const code = String(errorRecord.code ?? '').toUpperCase();
  if (RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const status =
    typeof errorRecord.status === 'number'
      ? errorRecord.status
      : typeof errorRecord.statusCode === 'number'
        ? errorRecord.statusCode
        : undefined;
  if (status !== undefined && RETRYABLE_HTTP_STATUS.has(status)) {
    return true;
  }

  const combined = `${mappedMessage}\n${params.error.message}`.toLowerCase();
  return combined.includes('socket hang up')
    || combined.includes('connection reset')
    || combined.includes('temporarily unavailable');
}

export function resolveRetryBackoffDelayMs(attempt: number): number {
  const baseMs = resolvePositiveInt(
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS,
    DEFAULT_RETRY_BACKOFF_BASE_MS,
  );
  const maxMs = resolvePositiveInt(
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS,
    DEFAULT_RETRY_BACKOFF_MAX_MS,
  );
  const exponent = Math.max(0, attempt - 1);
  const delay = baseMs * (2 ** exponent);
  return Math.min(delay, maxMs);
}

export async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('LLM retry delay aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('LLM retry delay aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}