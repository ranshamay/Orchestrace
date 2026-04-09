import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveRetryBackoffDelayMs,
  resolveTransientRequestRetries,
  shouldRetryTransientRequestFailure,
  waitForRetryDelay,
} from '../../src/adapter/retry.js';

describe('resolveRetryBackoffDelayMs', () => {
  afterEach(() => {
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS;
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS;
    delete process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS;
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

describe('resolveTransientRequestRetries', () => {
  it('uses default when unset or invalid', () => {
    delete process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS;
    expect(resolveTransientRequestRetries()).toBe(1);

    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '-1';
    expect(resolveTransientRequestRetries()).toBe(1);
  });

  it('uses configured transient retry attempts', () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '3';
    expect(resolveTransientRequestRetries()).toBe(3);
  });
});

describe('shouldRetryTransientRequestFailure', () => {
  it('retries timeout and rate-limit failures', () => {
    expect(
      shouldRetryTransientRequestFailure({
        failureType: 'timeout',
        mappedMessage: 'LLM request timed out after 300000ms',
        error: new Error('timed out'),
      }),
    ).toBe(true);

    expect(
      shouldRetryTransientRequestFailure({
        failureType: 'rate_limit',
        mappedMessage: '429 too many requests',
        error: Object.assign(new Error('too many requests'), { status: 429 }),
      }),
    ).toBe(true);
  });

  it('does not retry explicit aborted requests', () => {
    expect(
      shouldRetryTransientRequestFailure({
        failureType: 'unknown',
        mappedMessage: 'LLM request aborted before completion: cancelled',
        error: new Error('abort'),
      }),
    ).toBe(false);
  });

  it('retries known transient network codes', () => {
    expect(
      shouldRetryTransientRequestFailure({
        failureType: 'unknown',
        mappedMessage: 'socket error',
        error: Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }),
      }),
    ).toBe(true);
  });

  it('does not retry non-transient unknown failures', () => {
    expect(
      shouldRetryTransientRequestFailure({
        failureType: 'unknown',
        mappedMessage: 'validation failed',
        error: new Error('schema mismatch'),
      }),
    ).toBe(false);
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