import { describe, expect, it } from 'vitest';
import { validateAndNormalizeSessionPromptInput } from '../src/ui-server.js';

describe('validateAndNormalizeSessionPromptInput', () => {
  it('rejects non-string prompt values with explicit error code', () => {
    const result = validateAndNormalizeSessionPromptInput({
      prompt: 123,
      promptParts: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_INVALID_TYPE');
    expect(result.error).toContain('expected a string');
  });

  it('rejects empty prompt when prompt and promptParts are blank', () => {
    const result = validateAndNormalizeSessionPromptInput({
      prompt: '   ',
      promptParts: [{ type: 'text', text: '   ' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_EMPTY');
  });

  it('rejects prompts with unsupported control characters', () => {
    const result = validateAndNormalizeSessionPromptInput({
      prompt: 'Investigate bug\u0000with details',
      promptParts: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected invalid result');
    }

    expect(result.code).toBe('TASK_PROMPT_INVALID_CONTENT');
  });

  it('normalizes observer-style prompt and preserves valid markdown structure', () => {
    const result = validateAndNormalizeSessionPromptInput({
      prompt: '  [Observer Fix] Missing Input Sanitization\r\n\r\n## Task\r\nAdd prompt validation.  ',
      promptParts: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected valid result');
    }

    expect(result.normalizedPrompt).toBe('[Observer Fix] Missing Input Sanitization\n\n## Task\nAdd prompt validation.');
  });

  it('uses promptParts fallback when prompt is omitted and compacts inline image markdown', () => {
    const result = validateAndNormalizeSessionPromptInput({
      prompt: undefined,
      promptParts: [
        { type: 'text', text: 'Review screenshot evidence' },
        { type: 'text', text: '![](data:image/png;base64,abc123)' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected valid result');
    }

    expect(result.normalizedPrompt).toContain('Review screenshot evidence');
    expect(result.normalizedPrompt).toContain('[pasted-image]');
  });
});