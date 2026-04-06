import { encodingForModel } from 'js-tiktoken';

let encoder: ReturnType<typeof encodingForModel> | undefined;

function getEncoder(): ReturnType<typeof encodingForModel> {
  if (!encoder) {
    encoder = encodingForModel('gpt-4o');
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export function countTokensBatch(texts: string[]): number {
  let total = 0;
  const enc = getEncoder();
  for (const text of texts) {
    if (text) {
      try {
        total += enc.encode(text).length;
      } catch {
        total += Math.max(1, Math.ceil(text.length / 4));
      }
    }
  }
  return total;
}
