import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRetryBackoffDelayMs, waitForRetryDelay } from '../../src/adapter/retry.js';

describe('resolveRetryBackoffDelayMs', () => {
  afterEach(() => {
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS;
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS;
  });

  it('uses exponential growth with cap', () => {
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS = '100';
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS = '350';

    expect(resolveRetryBackoffDelayMs(1)).toBe(100);
    expect(resolveRetryBackoffDelayMs(2)).toBe(200);
    expect(resolveRetryBackoffDelayMs(3)).toBe(350);
    expect(resolveRetryBackoffDelayMs(4)).toBe(350);
  });
});

describe('waitForRetryDelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the configured delay', async () => {
    const promise = waitForRetryDelay(200);
    await vi.advanceTimersByTimeAsync(199);

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
  });

  it('rejects early when aborted', async () => {
    const controller = new AbortController();
    const promise = waitForRetryDelay(1_000, controller.signal);
    controller.abort(new Error('cancelled'));

    await expect(promise).rejects.toThrow('cancelled');
  });
});