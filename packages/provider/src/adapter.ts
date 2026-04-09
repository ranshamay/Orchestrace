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
import {
  resolveEmptyResponseRetries,
  resolveTransientRequestRetries,
  resolveRetryBackoffDelayMs,
  shouldRetryTransientRequestFailure,
  waitForRetryDelay,
} from './adapter/retry.js';
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
        const transientRequestRetries = resolveTransientRequestRetries();
        const missingToolCallRecoveryMaxAttempts = 1;
        const allowAuthRefreshRetry = request.allowAuthRefreshRetry === true;

        const authRefreshRetries = allowAuthRefreshRetry && request.refreshApiKey ? 1 : 0;

                const maxAttempts = Math.max(
          maxRetries,
          transientRequestRetries + missingToolCallRecoveryMaxAttempts,
          authRefreshRetries,
        ) + 1;

        const requestSignal = signal ?? request.signal;

        const scheduleRetryDelay = async (attempt: number): Promise<number> => {
          if (attempt >= maxAttempts) {
            return 0;
          }
          const delayMs = resolveRetryBackoffDelayMs(attempt);
          await waitForRetryDelay(delayMs, requestSignal);
          return delayMs;
        };

                let missingToolCallRecoveryAttempts = 0;

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
                        const canRetryAuth =
              failureType === 'auth'
              && allowAuthRefreshRetry
              && Boolean(request.refreshApiKey)
              && !authRetryUsed;

                        const canRetryMissingToolCallMapping =
              isMissingToolCallMappingFailureMessage(mapped.message)
              && missingToolCallRecoveryAttempts < missingToolCallRecoveryMaxAttempts;

            const canRetryTransient =
              attempt <= transientRequestRetries
              && shouldRetryTransientRequestFailure({
                failureType,
                mappedMessage: mapped.message,
                error,
              });
            const shouldRetry = canRetryAuth || canRetryTransient || canRetryMissingToolCallMapping;

            let retryDelayMs = 0;

            if (shouldRetry) {
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
              retryScheduled: shouldRetry,
              retryDelayMs,
              errorMessage: mapped.message,
              prompt: summarizePromptInput(prompt),
              ...summarizeErrorContext(error),
            });

            if (canRetryAuth) {
              authRetryUsed = true;
              try {
                                activeApiKey = await request.refreshApiKey?.({ forceRefresh: true });
              } catch {
                // Ignore refresh errors and retry once with the current key path.
              }
              attempt -= 1;
              continue;
            }

                        if (canRetryTransient || canRetryMissingToolCallMapping) {
              if (canRetryMissingToolCallMapping) {
                missingToolCallRecoveryAttempts += 1;
              }
              continue;
            }


                        throw createLlmFailureError({
              provider: request.provider,
              model: request.model,
              failureType,
              message: enrichAuthErrorMessage({
                provider: request.provider,
                failureType,
                message: mapped.message,
              }),
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
                        const canRetryAuth =
              failureType === 'auth'
              && allowAuthRefreshRetry
              && Boolean(request.refreshApiKey)
              && !authRetryUsed;

                        const canRetryMissingToolCallMapping =
              isMissingToolCallMappingFailureMessage(upstreamError)
              && missingToolCallRecoveryAttempts < missingToolCallRecoveryMaxAttempts;
            const retryDelayMs = (canRetryAuth || canRetryMissingToolCallMapping)
              ? await scheduleRetryDelay(attempt)
              : 0;

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
                            retryScheduled: canRetryAuth || canRetryMissingToolCallMapping,

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
                                activeApiKey = await request.refreshApiKey?.({ forceRefresh: true });
              } catch {
                // Ignore refresh errors and fall through to throw.
              }
              attempt -= 1;
              continue;
            }

            if (canRetryMissingToolCallMapping) {
              missingToolCallRecoveryAttempts += 1;
              continue;
            }

                        throw createLlmFailureError({

              provider: request.provider,
              model: request.model,
              failureType,
              message: enrichAuthErrorMessage({
                provider: request.provider,
                failureType,
                message: `Model ${request.provider}/${request.model} failed. ${reason}`,
              }),
            });

          }

          if (response.content.length === 0 && totalTokens === 0) {
            const failureType = classifyLlmFailure({
              message: upstreamError,
              stopReason: response.stopReason,
              kind: 'empty-zero-token',
            });
            const shouldRetry = attempt <= maxRetries;
            const retryDelayMs = shouldRetry ? await scheduleRetryDelay(attempt) : 0;
            logFailureDump({
              kind: 'empty-zero-token',
              failureType,
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              timeoutMs,
              elapsedMs,
              retryScheduled: shouldRetry,
              retryDelayMs,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });

            if (shouldRetry) {
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
            const shouldRetry = attempt <= maxRetries;
            const retryDelayMs = shouldRetry ? await scheduleRetryDelay(attempt) : 0;
            logFailureDump({
              kind: 'empty-text',
              failureType,
              provider: request.provider,
              model: request.model,
              baseUrl: model.baseUrl,
              attempt,
              maxAttempts,
              timeoutMs,
              elapsedMs,
              retryScheduled: shouldRetry,
              retryDelayMs,
              stopReason: response.stopReason,
              errorMessage: upstreamError,
              totalTokens,
              blockTypes,
              prompt: summarizePromptInput(prompt),
            });

            if (shouldRetry) {
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
      allowAuthRefreshRetry: request.allowAuthRefreshRetry,

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

const MISSING_TOOL_CALL_MAPPING_RE = /(no tool call found\s+for\s+function\s+call\s+output|function call output\s+with\s+call_id)/i;

function enrichAuthErrorMessage(params: {
  provider: string;
  failureType: ReturnType<typeof classifyLlmFailure>;
  message: string;
}): string {
  const { provider, failureType, message } = params;
  if (failureType !== 'auth' || provider !== 'github-copilot') {
    return message;
  }

  if (!/token expired|ide token expired/i.test(message)) {
    return message;
  }

  return `${message} Re-authenticate with \`orchestrace auth github-copilot\` and retry.`;
}

function isMissingToolCallMappingFailureMessage(message: string | undefined): boolean {

  if (typeof message !== 'string') {
    return false;
  }

  return MISSING_TOOL_CALL_MAPPING_RE.test(message);
}

