export function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asRequiredString(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) {
    throw new Error(`Missing ${field}`);
  }

  return parsed;
}

const MARKDOWN_LIKE_PAYLOAD = /(^\s*\[[^\]]+\])|(^\s*#{1,6}\s+\S)|(```)|(^\s*(?:Category|Severity|Issue|Task):\s)/im;
const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;
const FORBIDDEN_SHELL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_SHELL_LINE_BREAKS = /[\r\n]/;

export interface ShellCommandPayloadValidation {
  ok: boolean;
  reason?: string;
}

export interface ParsedShellCommand {
  program: string;
  args: string[];
}

export interface ShellCommandArgvValidation {
  ok: boolean;
  reason?: string;
  parsed?: ParsedShellCommand;
}

/**
 * Final pre-exec guard for run_command* tools.
 * Rejects markdown/prose payloads so observer/LLM instruction text never reaches command execution.
 */
export function validateShellCommandPayload(command: string): ShellCommandPayloadValidation {
  const normalized = command.trim();
  if (!normalized) {
    return { ok: false, reason: 'Blocked non-command payload: command was empty.' };
  }

  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked non-command payload: command contains multiple lines and appears to be markdown/instructions.',
    };
  }

  if (MARKDOWN_LIKE_PAYLOAD.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked non-command payload: command appears to be markdown/instructional text.',
    };
  }

  return { ok: true };
}

export function parseShellCommandToArgv(command: string): ShellCommandArgvValidation {
  const payloadValidation = validateShellCommandPayload(command);
  if (!payloadValidation.ok) {
    return payloadValidation;
  }

  const normalized = command.trim();
  if (FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked shell command: control characters are not allowed.',
    };
  }

  if (FORBIDDEN_SHELL_META_CHARS.test(normalized) || FORBIDDEN_SHELL_SUBSTITUTIONS.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked shell command: shell operators, redirection, piping, and substitutions are not allowed.',
    };
  }

  const tokenized = tokenizeCommandPreservingQuotes(normalized);
  if (!tokenized.ok || !tokenized.tokens) {
    return {
      ok: false,
      reason: tokenized.reason ?? 'Blocked shell command: unable to parse command safely.',
    };
  }

  const [program, ...args] = tokenized.tokens;
  return {
    ok: true,
    parsed: {
      program,
      args,
    },
  };
}

export function normalizeExecutableAllowlist(executables: string[] | undefined): string[] | undefined {
  if (!executables || executables.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of executables) {
    const parsed = asString(raw);
    if (!parsed) {
      continue;
    }

    const executable = parsed.toLowerCase();
    if (seen.has(executable)) {
      continue;
    }

    seen.add(executable);
    normalized.push(executable);
  }

  return normalized.length > 0 ? normalized : undefined;
}

export function deriveExecutableAllowlistFromPrefixes(prefixes: string[] | undefined): string[] | undefined {
  if (!prefixes || prefixes.length === 0) {
    return undefined;
  }

  const extracted = prefixes
    .map((prefix) => asString(prefix)?.split(/\s+/)[0])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return normalizeExecutableAllowlist(extracted);
}

export function matchesAllowedExecutable(program: string, allowedExecutables: string[] | undefined): boolean {
  if (!allowedExecutables || allowedExecutables.length === 0) {
    return false;
  }

  return allowedExecutables.includes(program.trim().toLowerCase());
}

export function looksDestructive(command: string): boolean {
  const normalized = command.toLowerCase();
  const blockedPatterns = [
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fdx\b/,
    /\brm\s+-rf\s+\/$/,
    /\bsudo\b/,
  ];

  return blockedPatterns.some((pattern) => pattern.test(normalized));
}

function tokenizeCommandPreservingQuotes(command: string): { ok: boolean; tokens?: string[]; reason?: string } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote === 'single') {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      continue;
    }

    if (char === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    return { ok: false, reason: 'Blocked shell command: trailing escape character is not supported.' };
  }

  if (quote) {
    return { ok: false, reason: 'Blocked shell command: unterminated quoted string.' };
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return { ok: false, reason: 'Blocked shell command: empty command after parsing.' };
  }

  return { ok: true, tokens };
}