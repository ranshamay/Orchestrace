const DEFAULT_EMPTY_RESPONSE_RETRIES = 1;

export function resolveEmptyResponseRetries(): number {
  const raw = process.env.ORCHESTRACE_EMPTY_RESPONSE_RETRIES;
  if (!raw) {
    return DEFAULT_EMPTY_RESPONSE_RETRIES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EMPTY_RESPONSE_RETRIES;
  }

  return parsed;
}