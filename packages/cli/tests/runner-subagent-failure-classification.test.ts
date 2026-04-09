import { describe, expect, it } from 'vitest';
import { __runnerTestUtils } from '../src/runner.js';

describe('runner sub-agent failure classification', () => {
  it('marks AbortError as recoverable abort', () => {
    const error = new Error('The operation was aborted by signal');
    error.name = 'AbortError';

    const classified = __runnerTestUtils.classifySubAgentFailure(error);
    expect(classified).toEqual({ failureType: 'abort', recoverable: true });
    expect(__runnerTestUtils.isRetryable(error)).toBe(true);
  });

  it('marks timeout-like errors as recoverable timeout', () => {
    const classified = __runnerTestUtils.classifySubAgentFailure(new Error('request timed out after 120000ms'));
    expect(classified).toEqual({ failureType: 'timeout', recoverable: true });
    expect(__runnerTestUtils.isRetryable(new Error('timeout'))).toBe(true);
  });

  it('marks rate-limit errors as recoverable rate_limit', () => {
    const classified = __runnerTestUtils.classifySubAgentFailure(new Error('429 too many requests'));
    expect(classified).toEqual({ failureType: 'rate_limit', recoverable: true });
    expect(__runnerTestUtils.isRetryable(new Error('rate limit exceeded'))).toBe(true);
  });

  it('keeps auth errors terminal', () => {
    const classified = __runnerTestUtils.classifySubAgentFailure(new Error('401 unauthorized'));
    expect(classified).toEqual({ failureType: 'auth', recoverable: false });
    expect(__runnerTestUtils.isRetryable(new Error('401 unauthorized'))).toBe(false);
  });

  it('keeps unknown errors terminal', () => {
    const classified = __runnerTestUtils.classifySubAgentFailure(new Error('unexpected parser panic'));
    expect(classified).toEqual({ failureType: 'unknown', recoverable: false });
    expect(__runnerTestUtils.isRetryable(new Error('unexpected parser panic'))).toBe(false);
  });
});