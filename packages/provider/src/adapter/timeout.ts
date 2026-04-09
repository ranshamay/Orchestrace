const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GITHUB_COPILOT_TIMEOUT_MS = 300_000;

export function resolveTimeoutMs(overrideMs?: number, provider?: string): number {
  if (Number.isFinite(overrideMs) && (overrideMs as number) > 0) {
    return overrideMs as number;
  }

  const providerTimeout = resolveProviderTimeoutMs(provider);
  if (providerTimeout !== undefined) {
    return providerTimeout;
  }

  const raw = process.env.ORCHESTRACE_LLM_TIMEOUT_MS;
  if (!raw) {
    return defaultTimeoutForProvider(provider);
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTimeoutForProvider(provider);
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
  const normalized = normalizeError(error);
  const message = normalized.message.toLowerCase();

  if (isTimeoutLike(message)) {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }

  if (isAbortLike(message)) {
    return new Error(`LLM request aborted before completion: ${normalized.message}`);
  }

  return normalized;
}

export function summarizeErrorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorValue: String(error) };
  }

  const context: Record<string, unknown> = {
    errorName: error.name,
    errorMessage: error.message,
  };

  const errorRecord = error as Error & {
    code?: unknown;
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    cause?: unknown;
  };

  if (typeof errorRecord.code === 'string' || typeof errorRecord.code === 'number') {
    context.errorCode = errorRecord.code;
  }
  if (typeof errorRecord.type === 'string') {
    context.errorType = errorRecord.type;
  }
  if (typeof errorRecord.status === 'number') {
    context.upstreamStatus = errorRecord.status;
  }
  if (typeof errorRecord.statusCode === 'number') {
    context.upstreamStatusCode = errorRecord.statusCode;
  }

  const causeMessage = extractCauseMessage(errorRecord.cause);
  if (causeMessage) {
    context.causeMessage = causeMessage;
  }

  return context;
}

function resolveProviderTimeoutMs(provider?: string): number | undefined {
  if (!provider) {
    return undefined;
  }

  const envProviderKey = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const raw = process.env[`ORCHESTRACE_LLM_TIMEOUT_MS_${envProviderKey}`];
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function defaultTimeoutForProvider(provider?: string): number {
  if (provider?.toLowerCase() === 'github-copilot') {
    return DEFAULT_GITHUB_COPILOT_TIMEOUT_MS;
  }

  return DEFAULT_TIMEOUT_MS;
}

function isTimeoutLike(message: string): boolean {
  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('etimedout')
    || message.includes('deadline exceeded');
}

function isAbortLike(message: string): boolean {
  if (!message.includes('abort')) {
    return false;
  }

  // Keep timeout classification authoritative when timeout phrasing is present.
  return !isTimeoutLike(message);
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function extractCauseMessage(cause: unknown): string | undefined {
  if (!cause) {
    return undefined;
  }

  if (cause instanceof Error) {
    return cause.message;
  }

  return typeof cause === 'string' ? cause : undefined;
}