import { getModel, type AssistantMessage } from '@mariozechner/pi-ai';
import type {
  LlmAdapter,
  LlmAgent,
  LlmModelInfo,
  LlmPromptInput,
  LlmRequest,
  LlmResult,
  SpawnAgentRequest,
  LlmCompletionOptions,
} from './types.js';
import { createContext, normalizeModelEndpoint } from './adapter/context.js';
import { executeWithOptionalTools } from './adapter/tools.js';
import { resolveTimeoutMs, mapTimeoutError, summarizeErrorContext } from './adapter/timeout.js';
import { resolveEmptyResponseRetries, resolveRetryBackoffDelayMs, waitForRetryDelay } from './adapter/retry.js';
import { summarizePromptInput, logFailureDump } from './adapter/failure.js';
import { mergeUsage } from './adapter/usage.js';
import { classifyLlmFailure, createLlmFailureError } from './adapter/failure-classifier.js';

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
        let activeApiKey = request.apiKey;
        let authRetryUsed = false;
        const maxRetries = resolveEmptyResponseRetries();
        const maxAttempts = maxRetries + 1;
        const requestSignal = signal ?? request.signal;

        const scheduleRetryDelay = async (attempt: number): Promise<number> => {
          if (attempt >= maxAttempts) {
            return 0;
          }
          const delayMs = resolveRetryBackoffDelayMs(attempt);
          await waitForRetryDelay(delayMs, requestSignal);
          return delayMs;
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const context = createContext(request, prompt);
          const options: Record<string, unknown> = {};
          if (request.reasoning && model.reasoning) {
            options.reasoning = request.reasoning;
          }
          const timeoutMs = resolveTimeoutMs(request.timeoutMs, request.provider);
          const attemptStartedAt = Date.now();
          if (activeApiKey) {
            options.apiKey = activeApiKey;
          }

          try {
            response = await executeWithOptionalTools({
              model,
              context,
              options,
              completionOptions,
              toolset: request.toolset,
              signal: signal ?? request.signal,
              timeoutMs,
              onUsage: (value) => {
                hasUsage = true;
                mergeUsage(usage, value);
              },
            });
          } catch (error) {
            const mapped = mapTimeoutError(error, timeoutMs);
            const failureType = classifyLlmFailure({ message: mapped.message });
            const elapsedMs = Date.now() - attemptStartedAt;
            const canRetryAuth = failureType === 'auth' && Boolean(request.refreshApiKey) && !authRetryUsed;
            let retryDelayMs = 0;

            if (canRetryAuth) {
              retryDelayMs = await scheduleRetryDelay(attempt);
            }

            logFailureDump({
              kind: 'request-error',
              failureType,
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              timeoutMs,
              elapsedMs,
              retryScheduled: canRetryAuth,
              retryDelayMs,
              errorMessage: mapped.message,
              prompt: summarizePromptInput(prompt),
              ...summarizeErrorContext(error),
            });

            if (canRetryAuth) {
              authRetryUsed = true;
              try {
                activeApiKey = await request.refreshApiKey?.();
              } catch {
                // Ignore refresh errors and retry once with the current key path.
              }
              attempt -= 1;
              continue;
            }

            throw createLlmFailureError({
              provider: request.provider,
              model: request.model,
              failureType,
              message: mapped.message,
              cause: error,
            });
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
          const elapsedMs = Date.now() - attemptStartedAt;

          if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            const failureType = classifyLlmFailure({
              message: upstreamError,
              stopReason: response.stopReason,
              kind: 'stop-reason',
            });
            const reason = upstreamError
              ? `Provider error: ${upstreamError}`
              : `Model stopped with reason "${response.stopReason}" before producing a usable response.`;
            const canRetryAuth = failureType === 'auth' && Boolean(request.refreshApiKey) && !authRetryUsed;
            const retryDelayMs = canRetryAuth ? await scheduleRetryDelay(attempt) : 0;
            logFailureDump({
              kind: 'stop-reason',
              failureType,
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              timeoutMs,
              elapsedMs,
              retryScheduled: canRetryAuth,
              retryDelayMs,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });

            if (canRetryAuth) {
              authRetryUsed = true;
              try {
                activeApiKey = await request.refreshApiKey?.();
              } catch {
                // Ignore refresh errors and fall through to throw.
              }
              attempt -= 1;
              continue;
            }

            throw createLlmFailureError({
              provider: request.provider,
              model: request.model,
              failureType,
              message: `Model ${request.provider}/${request.model} failed. ${reason}`,
            });
          }

          if (response.content.length === 0 && totalTokens === 0) {
            const failureType = classifyLlmFailure({
              message: upstreamError,
              stopReason: response.stopReason,
              kind: 'empty-zero-token',
            });
            logFailureDump({
              kind: 'empty-zero-token',
              failureType,
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
            throw createLlmFailureError({
              provider: request.provider,
              model: request.model,
              failureType,
              message:
                `Model ${request.provider}/${request.model} returned an empty response with zero tokens. `
                + details,
            });
          }

          if (!text.trim()) {
            const failureType = classifyLlmFailure({
              message: upstreamError,
              stopReason: response.stopReason,
              kind: 'empty-text',
            });
            logFailureDump({
              kind: 'empty-text',
              failureType,
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
            throw createLlmFailureError({
              provider: request.provider,
              model: request.model,
              failureType,
              message:
                `Model ${request.provider}/${request.model} returned no text output (blocks: ${blockTypes}). `
                + details,
            });
          }

          return {
            text,
            usage: hasUsage ? usage : undefined,
            metadata: {
              stopReason: response.stopReason,
              endpoint: model.baseUrl,
            },
          };
        }

        throw createLlmFailureError({
          provider: request.provider,
          model: request.model,
          failureType: 'unknown',
          message: `Model ${request.provider}/${request.model} failed after ${maxAttempts} attempt(s).`,
        });
      },
    };
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const agent = await this.spawnAgent({
      provider: request.provider,
      model: request.model,
      systemPrompt: request.systemPrompt,
      reasoning: request.reasoning,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      toolset: request.toolset,
      apiKey: request.apiKey,
      refreshApiKey: request.refreshApiKey,
    });
    return agent.complete(request.prompt, request.signal, {
      onTextDelta: request.onTextDelta,
      onUsage: request.onUsage,
      onToolCall: request.onToolCall,
    });
  }

  getModelInfo(provider: string, model: string): LlmModelInfo {
    const resolved = normalizeModelEndpoint(getModel(provider as never, model as never));
    return {
      contextWindow: resolved.contextWindow ?? 128_000,
      maxOutputTokens: resolved.maxTokens ?? 8_192,
    };
  }
}
