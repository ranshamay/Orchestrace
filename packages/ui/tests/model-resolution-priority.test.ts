import { describe, expect, it } from 'vitest';
import { resolveModelByPriority } from '../src/app/hooks/useProviderModels';

describe('model resolution priority', () => {
  it('prefers the specific model selected in controls', () => {
    const resolved = resolveModelByPriority({
      specificModel: 'claude-sonnet-4-20250514',
      defaultModel: 'claude-haiku-4.5',
      providerModels: ['claude-haiku-4.5', 'gemini-2.5-pro'],
    });

    expect(resolved).toBe('claude-sonnet-4-20250514');
  });

  it('falls back to step default model when specific model is empty', () => {
    const resolved = resolveModelByPriority({
      specificModel: '',
      defaultModel: 'claude-haiku-4.5',
      providerModels: ['gemini-2.5-pro', 'claude-haiku-4.5'],
    });

    expect(resolved).toBe('claude-haiku-4.5');
  });

  it('falls back to first provider model when neither specific nor valid default is available', () => {
    const resolved = resolveModelByPriority({
      specificModel: '',
      defaultModel: 'missing-model',
      providerModels: ['gemini-2.5-pro', 'claude-haiku-4.5'],
    });

    expect(resolved).toBe('gemini-2.5-pro');
  });

  it('returns empty string when provider has no models and no specific model', () => {
    const resolved = resolveModelByPriority({
      specificModel: '',
      defaultModel: 'claude-haiku-4.5',
      providerModels: [],
    });

    expect(resolved).toBe('');
  });
});
