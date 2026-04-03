import type { LlmPromptInput } from '../types.js';

export function summarizePromptInput(prompt: LlmPromptInput): Record<string, unknown> {
  if (typeof prompt === 'string') {
    return {
      type: 'text',
      chars: prompt.length,
    };
  }

  const textChars = prompt
    .filter((part) => part.type === 'text')
    .reduce((total, part) => total + part.text.length, 0);
  const imageCount = prompt.filter((part) => part.type === 'image').length;

  return {
    type: 'parts',
    parts: prompt.length,
    textChars,
    imageCount,
  };
}

export function logFailureDump(data: Record<string, unknown>): void {
  if (process.env.ORCHESTRACE_LLM_DUMP_LOGS === 'false') {
    return;
  }

  const payload = {
    time: new Date().toISOString(),
    ...data,
  };

  try {
    // Keep this single-line JSON so it can be grep'd from terminal logs.
    console.error('[orchestrace][provider][llm-failure]', JSON.stringify(payload));
  } catch {
    console.error('[orchestrace][provider][llm-failure]', payload);
  }
}