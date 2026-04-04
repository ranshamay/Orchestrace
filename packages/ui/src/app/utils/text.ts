export function stripRunTag(input: string): string {
  return input.replace(/^\[run:[^\]]+\]\s*/, '').trim();
}

export function stripTaskPrefix(input: string): string {
  return input.replace(/^[^:]+:\s*/, '').trim();
}

export function compactInline(input: string, maxChars = 220): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, maxChars - 3)}...`;
}

export function parseJsonObject(input: string): Record<string, unknown> | undefined {
  const value = input.trim();
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function compactPromptDisplay(prompt: string): string {
  return prompt
    .replace(/!\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+\)/g, '[pasted-image]')
    .replace(/\s+/g, ' ')
    .trim();
}