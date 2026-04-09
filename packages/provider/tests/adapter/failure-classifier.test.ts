import { describe, expect, it } from 'vitest';
import {
  classifyLlmFailure,
  createLlmFailureError,
  LlmFailureError,
} from '../../src/adapter/failure-classifier.js';

describe('classifyLlmFailure', () => {
  it('classifies timeout errors', () => {
    expect(classifyLlmFailure({ message: 'LLM request timed out after 120000ms' })).toBe('timeout');
  });

    it('classifies auth errors', () => {
    expect(classifyLlmFailure({ message: '401 Unauthorized: invalid api key' })).toBe('auth');
  });

  it('classifies Copilot token-expired auth failures', () => {
    expect(classifyLlmFailure({ message: '401 IDE token expired: unauthorized: token expired' })).toBe('auth');
  });


  it('classifies rate limit errors', () => {
    expect(classifyLlmFailure({ message: '429 too many requests' })).toBe('rate_limit');
  });

  it('classifies tool schema errors', () => {
    expect(classifyLlmFailure({ message: 'Invalid tool call: missing required argument' })).toBe('tool_schema');
  });

    it('classifies tool runtime errors', () => {
    expect(classifyLlmFailure({ message: 'Tool execution failed: blocked command' })).toBe('tool_runtime');
  });

  it('classifies missing tool call mapping provider errors as tool runtime', () => {
    expect(
      classifyLlmFailure({
        message: 'No tool call found for function call output with call_id call_2kIxaBWFuWjxnygjhoOPNPqu.',
      }),
    ).toBe('tool_runtime');
  });


  it('classifies empty responses by kind', () => {
    expect(classifyLlmFailure({ kind: 'empty-zero-token' })).toBe('empty_response');
    expect(classifyLlmFailure({ kind: 'empty-text' })).toBe('empty_response');
  });

  it('falls back to unknown for unmatched messages', () => {
    expect(classifyLlmFailure({ message: 'something unusual happened' })).toBe('unknown');
  });
});

describe('LlmFailureError', () => {
  it('creates typed errors with failure metadata', () => {
    const error = createLlmFailureError({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      failureType: 'rate_limit',
      message: '429 too many requests',
    });

    expect(error).toBeInstanceOf(LlmFailureError);
    expect(error.failureType).toBe('rate_limit');
    expect(error.provider).toBe('github-copilot');
    expect(error.model).toBe('gpt-5.3-codex');
  });
});
