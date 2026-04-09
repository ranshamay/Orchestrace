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
const SHELL_META_CHARACTERS = new Set(['|', '&', ';', '<', '>', '`', '*', '?', '[', ']', '~']);


export interface ShellCommandPayloadValidation {
  ok: boolean;
  reason?: string;
}

export interface ParsedShellCommand {
  program: string;
  args: string[];
}

/**
 * Final pre-exec guard for run_command* tools.
 * Rejects markdown/prose payloads so observer/LLM instruction text never reaches `zsh -lc`.
 */
export function validateShellCommandPayload(command: string): ShellCommandPayloadValidation {
  const normalized = command.trim();
  if (!normalized) {
    return { ok: false, reason: 'Blocked non-command payload: command was empty.' };
  }
  if (normalized.includes('\n')) {
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

export function shouldUseShellExecution(command: string): boolean {
  let quote: 'single' | 'double' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote === 'single') {
      if (ch === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === 'double') {
      if (ch === '"' && command[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      continue;
    }

    if (SHELL_META_CHARACTERS.has(ch)) {
      return true;
    }
  }

  return /\\\s/.test(command);
}


export function parseCommandToArgv(command: string): ParsedShellCommand | undefined {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote === 'single') {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        const next = command[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      continue;
    }

    if (ch === '\\') {
      const next = command[i + 1];
      if (next === undefined) {
        current += '\\';
      } else {
        current += next;
        i += 1;
      }
      continue;
    }

    current += ch;
  }

  if (quote !== null) {
    return undefined;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return undefined;
  }

  const [program, ...args] = tokens;
  return { program, args };
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