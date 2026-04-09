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