import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
} from '@mariozechner/pi-ai';
import type { LlmCompletionOptions } from '../types.js';

export async function consumeStream(
  model: ReturnType<typeof import('@mariozechner/pi-ai').getModel>,
  context: Context,
  options: Record<string, unknown>,
  completionOptions?: LlmCompletionOptions,
): Promise<AssistantMessage> {
  const stream = streamSimple(model, context, options);

  for await (const event of stream) {
    handleStreamEvent(event, completionOptions);
  }

  return stream.result();
}

export function handleStreamEvent(event: AssistantMessageEvent, completionOptions?: LlmCompletionOptions): void {
  if (event.type === 'text_delta') {
    completionOptions?.onTextDelta?.(event.delta);
  }

  const partial = 'partial' in event ? event.partial : undefined;
  const usage = partial?.usage;
  if (!usage) {
    return;
  }

  completionOptions?.onUsage?.({
    input: usage.input,
    output: usage.output,
    cost: usage.cost.total,
  });
}

export function getUsage(message: AssistantMessage): { input: number; output: number; cost: number } {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cost: message.usage.cost.total,
  };
}