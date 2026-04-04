export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}