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

export interface ShellCommandPayloadValidation {
  ok: boolean;
  reason?: string;
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