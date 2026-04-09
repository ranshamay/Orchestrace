const DEFAULT_MAX_COMMAND_LENGTH = 200;

export const DEFAULT_ALLOWED_SHELL_PROGRAMS = [
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

const MARKDOWN_LIKE_PAYLOAD = /(^\s*\[[^\]]+\])|(^\s*#{1,6}\s+\S)|(```)|(^\s*(?:Category|Severity|Issue|Task):\s)/im;
const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;
const FORBIDDEN_SHELL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_SHELL_LINE_BREAKS = /[\r\n]/;
const DEFAULT_COMMAND_PREFIX_PATTERN = /^(run|execute|exec|shell|command|cmd)\s+/i;

export interface ParsedShellCommand {
  program: string;
  args: string[];
}

export interface ShellExecutionValidation {
  ok: boolean;
  command?: string;
  parsed?: ParsedShellCommand;
  reason?: string;
}

export interface ShellCommandPolicy {
  allowedPrograms?: readonly string[];
  maxCommandLength?: number;
  commandPrefixPattern?: RegExp;
}

function normalizePolicy(policy?: ShellCommandPolicy): {
  allowedProgramsSet?: Set<string>;
  maxCommandLength: number;
  commandPrefixPattern: RegExp;
} {
  return {
    allowedProgramsSet: policy?.allowedPrograms
      ? new Set(policy.allowedPrograms.map((program) => program.toLowerCase()))
      : undefined,
    maxCommandLength: policy?.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH,
    commandPrefixPattern: policy?.commandPrefixPattern ?? DEFAULT_COMMAND_PREFIX_PATTERN,
  };
}

export function extractShellCommand(prompt: string, policy?: ShellCommandPolicy): string | undefined {
  const normalized = prompt.trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedPolicy = normalizePolicy(policy);
  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized) || FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return undefined;
  }
  if (normalized.length > normalizedPolicy.maxCommandLength) {
    return undefined;
  }

  const command = normalized
    .replace(/^\$\s*/, '')
    .replace(normalizedPolicy.commandPrefixPattern, '')
    .trim();
  if (!command) {
    return undefined;
  }

  if (normalizedPolicy.allowedProgramsSet) {
    const firstToken = firstTokenLower(command);
    if (!firstToken || !normalizedPolicy.allowedProgramsSet.has(firstToken)) {
      return undefined;
    }
  }

  return command;
}

function firstTokenLower(command: string): string | undefined {
  const tokenized = tokenizeCommandPreservingQuotes(command);
  if (!tokenized.ok || !tokenized.tokens || tokenized.tokens.length === 0) {
    return undefined;
  }

  return tokenized.tokens[0]?.toLowerCase();
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
    return { ok: false, reason: 'Rejected shell execution: trailing escape character is not supported.' };
  }
  if (quote) {
    return { ok: false, reason: 'Rejected shell execution: unterminated quoted string.' };
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return { ok: false, reason: 'Rejected shell execution: empty command after parsing.' };
  }

  return { ok: true, tokens };
}

export function parseShellCommandToArgv(command: string, policy?: ShellCommandPolicy): ShellExecutionValidation {
  const normalized = command.trim();
  const normalizedPolicy = normalizePolicy(policy);

  if (!normalized) {
    return { ok: false, reason: 'Rejected shell execution: command is empty.' };
  }

  if (normalized.length > normalizedPolicy.maxCommandLength) {
    return { ok: false, reason: 'Rejected shell execution: command exceeds maximum allowed length.' };
  }

  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized) || FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
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
  if (normalizedPolicy.allowedProgramsSet) {
    const normalizedProgram = program.toLowerCase();
    if (!normalizedPolicy.allowedProgramsSet.has(normalizedProgram)) {
      return {
        ok: false,
        reason: `Rejected shell execution: command '${program}' is not in the allowed shell command list.`,
      };
    }
  }

  return {
    ok: true,
    command: normalized,
    parsed: {
      program,
      args,
    },
  };
}

export function validateShellInput(input: string, policy?: ShellCommandPolicy): ShellExecutionValidation {
  const normalized = input.trim();
  if (!normalized) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but prompt was empty.',
    };
  }

  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt contains multiple lines and appears to be instructions/markdown, not a single command.',
    };
  }
  if (FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt contains control characters that are not allowed.',
    };
  }

  if (MARKDOWN_LIKE_PAYLOAD.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt appears to contain markdown/instructional content, not a direct command.',
    };
  }

  const command = extractShellCommand(normalized, policy);
  if (!command) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but no executable command was found in the prompt.',
    };
  }

  const parsed = parseShellCommandToArgv(command, policy);
  if (!parsed.ok || !parsed.parsed) {
    return {
      ok: false,
      reason: parsed.reason ?? 'Rejected shell execution: command contains unsupported or unsafe shell syntax.',
    };
  }

  return { ok: true, command, parsed: parsed.parsed };
}

export const DEFAULT_CLI_SHELL_COMMAND_POLICY: ShellCommandPolicy = {
  allowedPrograms: DEFAULT_ALLOWED_SHELL_PROGRAMS,
  maxCommandLength: DEFAULT_MAX_COMMAND_LENGTH,
};