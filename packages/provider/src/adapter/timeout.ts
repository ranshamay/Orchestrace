const DEFAULT_TIMEOUT_MS = 120_000;

export function resolveTimeoutMs(overrideMs?: number): number {
  if (Number.isFinite(overrideMs) && (overrideMs as number) > 0) {
    return overrideMs as number;
  }

  const raw = process.env.ORCHESTRACE_LLM_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function createTimeoutSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!baseSignal && timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromBase = () => {
    controller.abort(baseSignal?.reason ?? new Error('LLM request aborted'));
  };

  if (baseSignal) {
    if (baseSignal.aborted) {
      abortFromBase();
    } else {
      baseSignal.addEventListener('abort', abortFromBase, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (baseSignal) {
        baseSignal.removeEventListener('abort', abortFromBase);
      }
    },
  };
}

export function mapTimeoutError(error: unknown, timeoutMs: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('timed out') || message.toLowerCase().includes('abort')) {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }

  return error instanceof Error ? error : new Error(String(error));
}