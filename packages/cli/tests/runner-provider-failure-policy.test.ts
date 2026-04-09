import { describe, expect, it } from 'vitest';
import {
  isDegradableProviderFailureType,
  isRetryableProviderFailureType,
  normalizeLlmProviderFailurePolicy,
} from '../src/runner-provider-failure-policy.js';

describe('runner provider failure policy helpers', () => {
  it('normalizes known provider failure policy modes', () => {
    expect(normalizeLlmProviderFailurePolicy('strict')).toBe('strict');
    expect(normalizeLlmProviderFailurePolicy('degraded_noop')).toBe('degraded_noop');
    expect(normalizeLlmProviderFailurePolicy('DEGRADED_NOOP')).toBe('degraded_noop');
    expect(normalizeLlmProviderFailurePolicy('unknown')).toBeUndefined();
  });

  it('marks transient provider classes as retryable', () => {
    expect(isRetryableProviderFailureType('timeout')).toBe(true);
    expect(isRetryableProviderFailureType('rate_limit')).toBe(true);
    expect(isRetryableProviderFailureType('tool_runtime')).toBe(true);
    expect(isRetryableProviderFailureType('empty_response')).toBe(true);

    expect(isRetryableProviderFailureType('auth')).toBe(false);
    expect(isRetryableProviderFailureType('validation')).toBe(false);
    expect(isRetryableProviderFailureType('unknown')).toBe(false);
    expect(isRetryableProviderFailureType(undefined)).toBe(false);
  });

  it('allows degraded fallback for retryable and unknown provider failures only', () => {
    expect(isDegradableProviderFailureType('timeout')).toBe(true);
    expect(isDegradableProviderFailureType('rate_limit')).toBe(true);
    expect(isDegradableProviderFailureType('tool_runtime')).toBe(true);
    expect(isDegradableProviderFailureType('empty_response')).toBe(true);
    expect(isDegradableProviderFailureType('unknown')).toBe(true);

    expect(isDegradableProviderFailureType('auth')).toBe(false);
    expect(isDegradableProviderFailureType('validation')).toBe(false);
    expect(isDegradableProviderFailureType('tool_schema')).toBe(false);
    expect(isDegradableProviderFailureType(undefined)).toBe(false);
  });
});