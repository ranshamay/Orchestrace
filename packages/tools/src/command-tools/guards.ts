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

export function matchesAllowedPrefix(command: string, prefixes?: string[]): boolean {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  const normalized = command.trim().toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix.trim().toLowerCase()));
}

const MARKDOWN_LIKE_PAYLOAD = /(^\s*\[[^\]]+\])|(^\s*#{1,6}\s+\S)|(```)|(^\s*(?:Category|Severity|Issue|Task):\s)/im;
const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;
const FORBIDDEN_SHELL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_SHELL_LINE_BREAKS = /[\r\n]/;

const ALLOWED_SHELL_PROGRAMS = [
  'pnpm',
  'npm',
  'yarn',
  'node',
  'npx',
  'git',
  'cat',
  'echo',
  'grep',
  'find',
  'sed',
  'awk',
  'curl',
  'python',
  'make',
  'docker',
  'kubectl',
  'ls',
  'pwd',
] as const;

const ALLOWED_SHELL_PROGRAMS_SET = new Set<string>(ALLOWED_SHELL_PROGRAMS);

export interface ParsedShellCommand {
  program: string;
  args: string[];
}

export interface ShellCommandPayloadValidation {
  ok: boolean;
  reason?: string;
  parsed?: ParsedShellCommand;
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
    return { ok: false, reason: 'Blocked command payload: trailing escape character is not supported.' };
  }
  if (quote) {
    return { ok: false, reason: 'Blocked command payload: unterminated quoted string.' };
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return { ok: false, reason: 'Blocked command payload: command was empty after parsing.' };
  }

  return { ok: true, tokens };
}

/**
 * Final pre-exec guard for run_command* tools.
 * Rejects markdown/prose payloads and unsafe shell grammar, and returns parsed argv.
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
  if (FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked command payload: control characters are not allowed.',
    };
  }
  if (MARKDOWN_LIKE_PAYLOAD.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked non-command payload: command appears to be markdown/instructional text.',
    };
  }
  if (FORBIDDEN_SHELL_META_CHARS.test(normalized) || FORBIDDEN_SHELL_SUBSTITUTIONS.test(normalized)) {
    return {
      ok: false,
      reason: 'Blocked command payload: shell operators, redirection, piping, or substitution syntax is not allowed.',
    };
  }

  const tokenized = tokenizeCommandPreservingQuotes(normalized);
  if (!tokenized.ok || !tokenized.tokens) {
    return {
      ok: false,
      reason: tokenized.reason ?? 'Blocked command payload: unable to parse command safely.',
    };
  }

  const [program, ...args] = tokenized.tokens;
  const normalizedProgram = program.toLowerCase();
  if (!ALLOWED_SHELL_PROGRAMS_SET.has(normalizedProgram)) {
    return {
      ok: false,
      reason: `Blocked command payload: command '${program}' is not in the allowed shell command list.`,
    };
  }

  return {
    ok: true,
    parsed: {
      program,
      args,
    },
  };
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