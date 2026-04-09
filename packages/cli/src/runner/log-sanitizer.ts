const REDACTED_SECRET = '[REDACTED:secret]';
const REDACTED_PROMPT = '[REDACTED:prompt]';
const REDACTED_FILE_SNIPPET = '[REDACTED:file-snippet]';

const SECRET_KEY_REGEX = /(api[_-]?key|token|secret|password|authorization|auth|cookie|session[_-]?id|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;
const PROMPT_KEY_REGEX = /(prompt|systemPrompt|userPrompt|developerPrompt|originalPrompt|instructions)/i;
const FILE_SNIPPET_KEY_REGEX = /(fileSnippets?|snippet|snippets|content|contents|text|body|delta|patch|diff|stdout|stderr|input|output|payload)/i;
const STRUCTURED_HINT_REGEX = /^(\s*[\[{"']|\s*```(?:json)?|\s*\w+\s*[:=]\s*)/;

export interface LogSanitizerOptions {
  maxLength?: number;
}

export function sanitizeLogLine(line: string, options: LogSanitizerOptions = {}): string {
  const asString = typeof line === 'string' ? line : String(line ?? '');
  const trimmed = asString.trim();
  if (!trimmed) {
    return asString;
  }

  let sanitized = sanitizeSecrets(asString);

  if (looksStructured(trimmed)) {
    sanitized = sanitizeStructuredText(sanitized);
  }

  const maxLength = options.maxLength;
  if (typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength > 0 && sanitized.length > maxLength) {
    return `${sanitized.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  return sanitized;
}

export function sanitizeToolPayload(payload: string | undefined, options: LogSanitizerOptions = {}): string {
  if (payload == null) {
    return '(empty)';
  }

  const compact = sanitizeLogLine(payload, options).trim();
  return compact || '(blank)';
}

export function stringifySanitizedTracePayload(payload: string, options: LogSanitizerOptions = {}): string {
  return JSON.stringify(sanitizeLogLine(payload, options));
}

function sanitizeStructuredText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed !== undefined) {
    try {
      return JSON.stringify(sanitizeValue(parsed));
    } catch {
      return '[REDACTED:structured]';
    }
  }

  return redactStructuredFragments(text);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value, parentKey);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, parentKey));
  }

  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(input)) {
      if (PROMPT_KEY_REGEX.test(key)) {
        out[key] = REDACTED_PROMPT;
        continue;
      }
      if (SECRET_KEY_REGEX.test(key)) {
        out[key] = REDACTED_SECRET;
        continue;
      }
      if (FILE_SNIPPET_KEY_REGEX.test(key)) {
        out[key] = REDACTED_FILE_SNIPPET;
        continue;
      }
      out[key] = sanitizeValue(inner, key);
    }
    return out;
  }

  return value;
}

function sanitizeStringValue(value: string, parentKey?: string): string {
  if (!value) {
    return value;
  }

  if (parentKey && PROMPT_KEY_REGEX.test(parentKey)) {
    return REDACTED_PROMPT;
  }

  if (parentKey && SECRET_KEY_REGEX.test(parentKey)) {
    return REDACTED_SECRET;
  }

  if (parentKey && FILE_SNIPPET_KEY_REGEX.test(parentKey)) {
    return REDACTED_FILE_SNIPPET;
  }

  return sanitizeSecrets(value);
}

function sanitizeSecrets(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED_SECRET)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED_SECRET)
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, `Bearer ${REDACTED_SECRET}`)
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s"',;]+/gi, (_, key: string) => `${key}=${REDACTED_SECRET}`)
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '[REDACTED:image-data]');
}

function redactStructuredFragments(text: string): string {
  return text
    .replace(/("(?:prompt|systemPrompt|userPrompt|developerPrompt|originalPrompt|instructions)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi, `$1${REDACTED_PROMPT}$2`)
    .replace(/("(?:api[_-]?key|token|secret|password|authorization|cookie|access[_-]?token|refresh[_-]?token)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi, `$1${REDACTED_SECRET}$2`)
    .replace(/("(?:fileSnippets?|snippet|snippets|content|contents|text|body|delta|patch|diff|stdout|stderr|input|output|payload)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi, `$1${REDACTED_FILE_SNIPPET}$2`);
}

function looksStructured(text: string): boolean {
  return STRUCTURED_HINT_REGEX.test(text);
}

export const LOG_REDACTION_MARKERS = {
  secret: REDACTED_SECRET,
  prompt: REDACTED_PROMPT,
  fileSnippet: REDACTED_FILE_SNIPPET,
} as const;