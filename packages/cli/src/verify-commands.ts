const JEST_ONLY_FLAGS_FOR_VITEST = new Set(['--runinband']);
const TEST_FILTER_FLAGS = new Set(['-t', '--testnamepattern']);

function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function isVitestCommand(command: string): boolean {
  const tokens = tokenizeCommand(command).map((token) => token.toLowerCase());
  return tokens.some((token) => token === 'vitest' || token.endsWith('/vitest') || token.endsWith('\\vitest'));
}

function stripJestOnlyFlagsForVitest(command: string): string {
  const tokens = tokenizeCommand(command);
  const sanitized = tokens.filter((token) => !JEST_ONLY_FLAGS_FOR_VITEST.has(token.toLowerCase()));
  return sanitized.join(' ');
}

function normalizePnpmTestFilterArgs(command: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) {
    return command;
  }

  if (tokens[0] !== 'pnpm' || tokens[1] !== 'test') {
    return command;
  }

  const existingForwardSeparatorIndex = tokens.indexOf('--');
  if (existingForwardSeparatorIndex !== -1) {
    return command;
  }

  const hasFilterFlag = tokens.slice(2).some((token) => TEST_FILTER_FLAGS.has(token.toLowerCase()));
  if (!hasFilterFlag) {
    return command;
  }

  // pnpm test maps to turbo; test filter flags must be forwarded after `--` to avoid turbo arg parsing failures.
  return ['pnpm', 'test', '--', ...tokens.slice(2)].join(' ');
}

export function sanitizeVerifyCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = normalizePnpmTestFilterArgs(trimmed);

  if (!isVitestCommand(normalized)) {
    return normalized;
  }

  return stripJestOnlyFlagsForVitest(normalized);
}


export function parseAndSanitizeVerifyCommands(raw: string | undefined): string[] {
  const commands = raw
    ? raw.split(';').map((part) => part.trim()).filter((part) => part.length > 0)
    : ['pnpm typecheck', 'pnpm test'];

  return commands
    .map((command) => sanitizeVerifyCommand(command))
    .filter((command) => command.length > 0);
}