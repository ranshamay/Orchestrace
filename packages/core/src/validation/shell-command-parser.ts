export interface ParsedShellCommand {
  program: string;
  args: string[];
}

export interface ShellCommandParseResult {
  ok: boolean;
  parsed?: ParsedShellCommand;
  reason?: string;
}

const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_LINE_BREAKS = /[\r\n]/;

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
    return {
      ok: false,
      reason: 'Rejected shell execution: trailing escape character is not supported.',
    };
  }

  if (quote) {
    return {
      ok: false,
      reason: 'Rejected shell execution: unterminated quoted string.',
    };
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return {
      ok: false,
      reason: 'Rejected shell execution: empty command after parsing.',
    };
  }

  return { ok: true, tokens };
}

export function parseShellCommandToArgv(command: string): ShellCommandParseResult {
  const normalized = command.trim();

  if (!normalized) {
    return {
      ok: false,
      reason: 'Rejected shell execution: command is empty.',
    };
  }

  if (FORBIDDEN_LINE_BREAKS.test(normalized) || FORBIDDEN_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: control characters and line breaks are not allowed.',
    };
  }

  if (FORBIDDEN_SHELL_META_CHARS.test(normalized) || FORBIDDEN_SHELL_SUBSTITUTIONS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: shell operators, redirection, piping, or substitution syntax is not allowed.',
    };
  }

  const tokenized = tokenizeCommandPreservingQuotes(normalized);
  if (!tokenized.ok || !tokenized.tokens) {
    return {
      ok: false,
      reason: tokenized.reason ?? 'Rejected shell execution: unable to parse command safely.',
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