const JEST_ONLY_FLAGS_FOR_VITEST = new Set(['--runinband']);

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

export function sanitizeVerifyCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  if (!isVitestCommand(trimmed)) {
    return trimmed;
  }

  return stripJestOnlyFlagsForVitest(trimmed);
}

export function parseAndSanitizeVerifyCommands(raw: string | undefined): string[] {
  const commands = raw
    ? raw.split(';').map((part) => part.trim()).filter((part) => part.length > 0)
    : ['pnpm typecheck', 'pnpm test'];

  return commands
    .map((command) => sanitizeVerifyCommand(command))
    .filter((command) => command.length > 0);
}