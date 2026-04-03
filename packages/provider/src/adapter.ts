import { getModel, type AssistantMessage } from '@mariozechner/pi-ai';
import type {
  LlmAdapter,
  LlmAgent,
  LlmPromptInput,
  LlmRequest,
  LlmResult,
  SpawnAgentRequest,
  LlmCompletionOptions,
} from './types.js';
import { createContext, normalizeModelEndpoint } from './adapter/context.js';
import { executeWithOptionalTools } from './adapter/tools.js';
import { resolveTimeoutMs, createTimeoutSignal, mapTimeoutError } from './adapter/timeout.js';
import { resolveEmptyResponseRetries } from './adapter/retry.js';
import { summarizePromptInput, logFailureDump } from './adapter/failure.js';
import { mergeUsage } from './adapter/usage.js';

/**
 * LLM adapter backed by pi-ai.
 * Uses `completeSimple` for straightforward prompt→response flows.
 * API keys can be provided explicitly or read from environment variables by pi-ai.
 */
export class PiAiAdapter implements LlmAdapter {
  async spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const model = normalizeModelEndpoint(getModel(request.provider as never, request.model as never));

    return {
      complete: async (
        prompt: LlmPromptInput,
        signal?: AbortSignal,
        completionOptions?: LlmCompletionOptions,
      ): Promise<LlmResult> => {
        let response: AssistantMessage;
        const usage = { input: 0, output: 0, cost: 0 };
        let hasUsage = false;
        const maxRetries = resolveEmptyResponseRetries();
        const maxAttempts = maxRetries + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const context = createContext(request, prompt);
          const options: Record<string, unknown> = {};
          if (request.reasoning && model.reasoning) {
            options.reasoning = request.reasoning;
          }
          const timeoutMs = resolveTimeoutMs();
          const timeoutSignal = createTimeoutSignal(signal ?? request.signal, timeoutMs);
          if (timeoutSignal.signal) {
            options.signal = timeoutSignal.signal;
          }
          if (request.apiKey) {
            options.apiKey = request.apiKey;
          }

          try {
            response = await executeWithOptionalTools({
              model,
              context,
              options,
              completionOptions,
              toolset: request.toolset,
              signal: timeoutSignal.signal,
              onUsage: (value) => {
                hasUsage = true;
                mergeUsage(usage, value);
              },
            });
          } catch (error) {
            throw mapTimeoutError(error, timeoutMs);
          } finally {
            timeoutSignal.cleanup();
          }

          let text = '';
          for (const block of response.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }

          const upstreamError = response.errorMessage?.trim();
          const totalTokens = response.usage?.totalTokens ?? 0;
          const blockTypes = response.content.map((block) => block.type).join(', ') || 'none';

          if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            const reason = upstreamError
              ? `Provider error: ${upstreamError}`
              : `Model stopped with reason "${response.stopReason}" before producing a usable response.`;
            logFailureDump({
              kind: 'stop-reason',
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });
            throw new Error(`Model ${request.provider}/${request.model} failed. ${reason}`);
          }

          if (response.content.length === 0 && totalTokens === 0) {
            logFailureDump({
              kind: 'empty-zero-token',
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });

            if (attempt < maxAttempts) {
              continue;
            }

            const details = upstreamError
              ? `Provider error: ${upstreamError}`
              : 'This model may be unavailable for your account. Try another model.';
            throw new Error(
              `Model ${request.provider}/${request.model} returned an empty response with zero tokens. `
              + details,
            );
          }

          if (!text.trim()) {
            logFailureDump({
              kind: 'empty-text',
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });

            if (attempt < maxAttempts) {
              continue;
            }

            const details = upstreamError ? ` Provider error: ${upstreamError}` : ' Try another model.';
            throw new Error(
              `Model ${request.provider}/${request.model} returned no text output (blocks: ${blockTypes}). `
              + details,
            );
          }

          return {
            text,
            usage: hasUsage ? usage : undefined,
          };
        }

        throw new Error(`Model ${request.provider}/${request.model} failed after ${maxAttempts} attempt(s).`);
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
      toolset: request.toolset,
      apiKey: request.apiKey,
    });
    return agent.complete(request.prompt, request.signal, {
      onTextDelta: request.onTextDelta,
      onUsage: request.onUsage,
      onToolCall: request.onToolCall,
    });
  }
}
