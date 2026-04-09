import type { LlmFailureType } from '../types.js';

const DEFAULT_EMPTY_RESPONSE_RETRIES = 1;
const DEFAULT_TRANSIENT_FAILURE_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_500;
const DEFAULT_RETRY_MAX_DELAY_MS = 12_000;
const DEFAULT_RETRY_JITTER_RATIO = 0;

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

export function resolveTransientFailureRetries(): number {
  const raw = process.env.ORCHESTRACE_LLM_TRANSIENT_RETRIES;
  if (!raw) {
    return DEFAULT_TRANSIENT_FAILURE_RETRIES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TRANSIENT_FAILURE_RETRIES;
  }

  return parsed;
}

export function resolveRetryBaseDelayMs(): number {
  const raw = process.env.ORCHESTRACE_LLM_RETRY_BASE_DELAY_MS;
  if (!raw) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }

  return parsed;
}

export function resolveRetryMaxDelayMs(): number {
  const raw = process.env.ORCHESTRACE_LLM_RETRY_MAX_DELAY_MS;
  if (!raw) {
    return DEFAULT_RETRY_MAX_DELAY_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_MAX_DELAY_MS;
  }

  return parsed;
}

export function resolveRetryJitterRatio(): number {
  const raw = process.env.ORCHESTRACE_LLM_RETRY_JITTER_RATIO;
  if (!raw) {
    return DEFAULT_RETRY_JITTER_RATIO;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETRY_JITTER_RATIO;
  }

  return Math.max(0, Math.min(parsed, 1));
}

export function isRetryableTransientFailure(failureType: LlmFailureType): boolean {
  return failureType === 'timeout' || failureType === 'rate_limit' || failureType === 'unknown';
}

export function isFutileRetryFailure(failureType: LlmFailureType): boolean {
  return failureType === 'prompt_too_large' || failureType === 'provider_unresponsive';
}

export function computeRetryDelayMs(attempt: number): number {
  const baseDelayMs = resolveRetryBaseDelayMs();
  const maxDelayMs = Math.max(baseDelayMs, resolveRetryMaxDelayMs());
  const jitterRatio = resolveRetryJitterRatio();

  const exponent = Math.max(0, attempt - 1);
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));

  if (jitterRatio <= 0) {
    return rawDelay;
  }

  const amplitude = rawDelay * jitterRatio;
  const jitter = (Math.random() * 2 - 1) * amplitude;
  return Math.max(0, Math.round(rawDelay + jitter));
}

export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const abort = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(signal?.reason ?? new Error('LLM retry backoff aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    timeoutId = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', abort);
      }
      resolve();
    }, ms);
  });
}