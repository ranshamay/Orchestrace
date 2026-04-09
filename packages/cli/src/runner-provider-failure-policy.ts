import type { LlmProviderFailurePolicy } from '@orchestrace/store';

export function normalizeLlmProviderFailurePolicy(value: unknown): LlmProviderFailurePolicy | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'degraded_noop') {
    return normalized;
  }

  return undefined;
}

export function isRetryableProviderFailureType(failureType: string | undefined): boolean {
  return failureType === 'timeout'
    || failureType === 'rate_limit'
    || failureType === 'tool_runtime'
    || failureType === 'empty_response';
}

export function isDegradableProviderFailureType(failureType: string | undefined): boolean {
  return isRetryableProviderFailureType(failureType) || failureType === 'unknown';
}