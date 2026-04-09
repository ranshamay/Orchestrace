import { afterEach, describe, expect, it } from 'vitest';
import { mapTimeoutError, resolveTimeoutMs, summarizeErrorContext } from '../../src/adapter/timeout.js';

describe('resolveTimeoutMs', () => {
  afterEach(() => {
    delete process.env.ORCHESTRACE_LLM_TIMEOUT_MS;
    delete process.env.ORCHESTRACE_LLM_TIMEOUT_MS_GITHUB_COPILOT;
  });

  it('prefers explicit request override', () => {
    process.env.ORCHESTRACE_LLM_TIMEOUT_MS = '180000';
    expect(resolveTimeoutMs(45_000, 'github-copilot')).toBe(45_000);
  });

  it('uses provider-specific env override when present', () => {
    process.env.ORCHESTRACE_LLM_TIMEOUT_MS_GITHUB_COPILOT = '240000';
    process.env.ORCHESTRACE_LLM_TIMEOUT_MS = '180000';
    expect(resolveTimeoutMs(undefined, 'github-copilot')).toBe(240_000);
  });

  it('uses longer default for github-copilot', () => {
    expect(resolveTimeoutMs(undefined, 'github-copilot')).toBe(300_000);
  });

  it('uses global default for non-copilot providers', () => {
    expect(resolveTimeoutMs(undefined, 'openai')).toBe(120_000);
  });
});

describe('mapTimeoutError', () => {
  it('normalizes timeout-like messages', () => {
    const mapped = mapTimeoutError(new Error('deadline exceeded by upstream'), 200_000);
    expect(mapped.message).toBe('LLM request timed out after 200000ms');
  });

  it('preserves abort semantics instead of mapping to timeout', () => {
    const mapped = mapTimeoutError(new Error('Request was aborted'), 200_000);
    expect(mapped.message).toContain('LLM request aborted before completion');
    expect(mapped.message).toContain('Request was aborted');
  });
});

describe('summarizeErrorContext', () => {
  it('extracts useful upstream metadata fields', () => {
    const error = Object.assign(new Error('gateway failure'), {
      code: 'ECONNRESET',
      status: 502,
      statusCode: 502,
      type: 'upstream_error',
      cause: new Error('socket hang up'),
    });

    const context = summarizeErrorContext(error);
    expect(context).toMatchObject({
      errorName: 'Error',
      errorMessage: 'gateway failure',
      errorCode: 'ECONNRESET',
      upstreamStatus: 502,
      upstreamStatusCode: 502,
      errorType: 'upstream_error',
      causeMessage: 'socket hang up',
    });
  });
});