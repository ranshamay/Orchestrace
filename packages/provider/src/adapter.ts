import {
  getModel,
  completeSimple,
  type Context,
} from '@mariozechner/pi-ai';
import type { LlmAdapter, LlmRequest, LlmResult } from './types.js';

/**
 * LLM adapter backed by pi-ai.
 * Uses `completeSimple` for straightforward prompt→response flows.
 * API keys are read from environment variables automatically by pi-ai.
 */
export class PiAiAdapter implements LlmAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    const model = getModel(request.provider as never, request.model as never);

    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }],
    };

    const options: Record<string, unknown> = {};
    if (request.reasoning && model.reasoning) {
      options.reasoning = request.reasoning;
    }
    if (request.signal) {
      options.signal = request.signal;
    }

    const response = await completeSimple(model, context, options);

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }

    return {
      text,
      usage: response.usage
        ? {
            input: response.usage.input,
            output: response.usage.output,
            cost: response.usage.cost.total,
          }
        : undefined,
    };
  }
}
