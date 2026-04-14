type KeyLike = Pick<KeyboardEvent, "key" | "shiftKey">;

export function normalizeQuickPrompt(value: string): string {
  return value.trim();
}

export function canSubmitQuickPrompt(value: string): boolean {
  return normalizeQuickPrompt(value).length > 0;
}

export function shouldSubmitQuickPrompt(event: KeyLike): boolean {
  return event.key === "Enter" && !event.shiftKey;
}

export function shouldCloseQuickPrompt(
  event: Pick<KeyboardEvent, "key">,
): boolean {
  return event.key === "Escape";
}
