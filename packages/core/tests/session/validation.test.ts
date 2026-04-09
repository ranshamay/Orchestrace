import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_PROMPT_MAX_LENGTH,
  validateTaskPromptInput,
} from '../../src/session/validation.js';

describe('validateTaskPromptInput', () => {
  it('accepts and sanitizes a valid prompt', () => {
    const result = validateTaskPromptInput({
      prompt: '  Implement feature X\r\nwith tests.  ',
    });

    expect(result).toEqual({
      ok: true,
      sanitizedPrompt: 'Implement feature X\nwith tests.',
      maxLength: DEFAULT_TASK_PROMPT_MAX_LENGTH,
    });
  });

  it('rejects non-string prompt input when prompt is explicitly provided', () => {
    const result = validateTaskPromptInput({
      prompt: 42,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_INVALID_TYPE');
    expect(result.error).toContain('expected a string');
    expect(result.details).toEqual({ receivedType: 'number' });
  });

  it('rejects empty prompt after sanitization', () => {
    const result = validateTaskPromptInput({
      prompt: '   \n\t  ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_EMPTY');
  });

  it('rejects prompts above max length', () => {
    const result = validateTaskPromptInput({
      prompt: 'a'.repeat(11),
      maxLength: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_TOO_LONG');
    expect(result.details).toEqual({ length: 11 });
  });

  it('rejects prompts containing unsupported control characters', () => {
    const result = validateTaskPromptInput({
      prompt: 'valid\u0000invalid',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_INVALID_CONTENT');
    expect(result.details).toEqual({ characterCode: 0 });
  });

  it('accepts fallback prompt when primary prompt is omitted', () => {
    const result = validateTaskPromptInput({
      prompt: undefined,
      fallbackPrompt: '   synthesized prompt from parts   ',
    });

    expect(result).toEqual({
      ok: true,
      sanitizedPrompt: 'synthesized prompt from parts',
      maxLength: DEFAULT_TASK_PROMPT_MAX_LENGTH,
    });
  });

  it('uses floor max length and guards invalid max length values', () => {
    const first = validateTaskPromptInput({ prompt: 'abc', maxLength: 3.9 });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error('Expected valid result');
    }
    expect(first.maxLength).toBe(3);

    const second = validateTaskPromptInput({ prompt: 'a', maxLength: 0 });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error('Expected valid result');
    }
    expect(second.maxLength).toBe(1);
  });
});