const DEFAULT_EMPTY_RESPONSE_RETRIES = 1;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 800;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 8_000;

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