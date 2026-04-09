import { describe, expect, it } from 'vitest';
import { classifySubAgentFailure, isRetryableSubAgentFailure } from '../src/runner-subagent-failure.js';

describe('runner sub-agent failure classification', () => {
  it('marks AbortError as recoverable abort', () => {
    const error = new Error('The operation was aborted by signal');
    error.name = 'AbortError';

    const classified = classifySubAgentFailure(error);
    expect(classified).toEqual({ failureType: 'abort', recoverable: true });
    expect(isRetryableSubAgentFailure(error)).toBe(true);
  });

  it('marks timeout-like errors as recoverable timeout', () => {
    const classified = classifySubAgentFailure(new Error('request timed out after 120000ms'));
    expect(classified).toEqual({ failureType: 'timeout', recoverable: true });
    expect(isRetryableSubAgentFailure(new Error('timeout'))).toBe(true);
  });

  it('marks rate-limit errors as recoverable rate_limit', () => {
    const classified = classifySubAgentFailure(new Error('429 too many requests'));
    expect(classified).toEqual({ failureType: 'rate_limit', recoverable: true });
    expect(isRetryableSubAgentFailure(new Error('rate limit exceeded'))).toBe(true);
  });

  it('keeps auth errors terminal', () => {
    const classified = classifySubAgentFailure(new Error('401 unauthorized'));
    expect(classified).toEqual({ failureType: 'auth', recoverable: false });
    expect(isRetryableSubAgentFailure(new Error('401 unauthorized'))).toBe(false);
  });

      it('treats missing tool-call mapping errors as recoverable tool_runtime', () => {
    const err = new Error('No tool call found for function call output with call_id call_123.');
    const classified = classifySubAgentFailure(err);
    expect(classified).toEqual({ failureType: 'tool_runtime', recoverable: true });
    expect(isRetryableSubAgentFailure(err)).toBe(true);
  });

  it('keeps unknown errors terminal', () => {
    const classified = classifySubAgentFailure(new Error('unexpected parser panic'));
    expect(classified).toEqual({ failureType: 'unknown', recoverable: false });
    expect(isRetryableSubAgentFailure(new Error('unexpected parser panic'))).toBe(false);
  });
});
