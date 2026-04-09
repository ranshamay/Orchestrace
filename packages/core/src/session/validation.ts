const DEFAULT_TASK_PROMPT_MAX_LENGTH = 12_000;

const DISALLOWED_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type TaskPromptValidationErrorCode =
  | 'TASK_PROMPT_INVALID_TYPE'
  | 'TASK_PROMPT_EMPTY'
  | 'TASK_PROMPT_TOO_LONG'
  | 'TASK_PROMPT_INVALID_CONTENT';

export type ValidateTaskPromptInputParams = {
  prompt: unknown;
  fallbackPrompt?: string;
  maxLength?: number;
};

export type TaskPromptValidationResult =
  | {
      ok: true;
      sanitizedPrompt: string;
      maxLength: number;
    }
  | {
      ok: false;
      code: TaskPromptValidationErrorCode;
      error: string;
      maxLength: number;
      details?: Record<string, unknown>;
    };

export function validateTaskPromptInput(params: ValidateTaskPromptInputParams): TaskPromptValidationResult {
  const maxLength = Number.isFinite(params.maxLength)
    ? Math.max(1, Math.floor(Number(params.maxLength)))
    : DEFAULT_TASK_PROMPT_MAX_LENGTH;

  const hasExplicitPrompt = params.prompt !== undefined && params.prompt !== null;
  if (hasExplicitPrompt && typeof params.prompt !== 'string') {
    return {
      ok: false,
      code: 'TASK_PROMPT_INVALID_TYPE',
      error: 'Invalid prompt: expected a string value.',
      maxLength,
      details: {
        receivedType: typeof params.prompt,
      },
    };
  }

  const directPrompt = typeof params.prompt === 'string' ? sanitizeTaskPrompt(params.prompt) : '';
  const fallbackPrompt = sanitizeTaskPrompt(params.fallbackPrompt ?? '');
  const effectivePrompt = directPrompt || fallbackPrompt;

  if (!effectivePrompt) {
    return {
      ok: false,
      code: 'TASK_PROMPT_EMPTY',
      error: 'Missing prompt: provide a non-empty task prompt.',
      maxLength,
    };
  }

  if (effectivePrompt.length > maxLength) {
    return {
      ok: false,
      code: 'TASK_PROMPT_TOO_LONG',
      error: `Prompt exceeds maximum length of ${maxLength} characters.`,
      maxLength,
      details: {
        length: effectivePrompt.length,
      },
    };
  }

  const invalidControlCharacterMatch = effectivePrompt.match(DISALLOWED_CONTROL_CHARACTER_PATTERN);
  if (invalidControlCharacterMatch) {
    const invalidCharacter = invalidControlCharacterMatch[0] ?? '';
    return {
      ok: false,
      code: 'TASK_PROMPT_INVALID_CONTENT',
      error: 'Prompt contains unsupported control characters.',
      maxLength,
      details: {
        characterCode: invalidCharacter.charCodeAt(0),
      },
    };
  }

  return {
    ok: true,
    sanitizedPrompt: effectivePrompt,
    maxLength,
  };
}

function sanitizeTaskPrompt(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .trim();
}

export { DEFAULT_TASK_PROMPT_MAX_LENGTH };