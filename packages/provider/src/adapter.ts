import {
  getModel,
  completeSimple,
  type Context,
} from '@mariozechner/pi-ai';
import type { LlmAdapter, LlmAgent, LlmRequest, LlmResult, SpawnAgentRequest } from './types.js';

/**
 * LLM adapter backed by pi-ai.
 * Uses `completeSimple` for straightforward prompt→response flows.
 * API keys are read from environment variables automatically by pi-ai.
 */
export class PiAiAdapter implements LlmAdapter {
  async spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const model = getModel(request.provider as never, request.model as never);

    return {
      complete: async (prompt: string, signal?: AbortSignal): Promise<LlmResult> => {
        const context: Context = {
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        };

        const options: Record<string, unknown> = {};
        if (request.reasoning && model.reasoning) {
          options.reasoning = request.reasoning;
        }
        if (signal ?? request.signal) {
          options.signal = signal ?? request.signal;
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
      },
    };
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const agent = await this.spawnAgent({
      provider: request.provider,
      model: request.model,
      systemPrompt: request.systemPrompt,
      reasoning: request.reasoning,
      signal: request.signal,
    });
    return agent.complete(request.prompt, request.signal);
  }
}
