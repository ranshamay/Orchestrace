import {
  validateToolCall,
  getModel,
  streamSimple,
  type Context,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';
import type {
  LlmAdapter,
  LlmAgent,
  LlmPromptInput,
  LlmRequest,
  LlmResult,
  SpawnAgentRequest,
  LlmCompletionOptions,
  LlmToolset,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOOL_ROUNDS = resolveMaxToolRounds();

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

        let response: AssistantMessage;
        const usage = { input: 0, output: 0, cost: 0 };
        let hasUsage = false;
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
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          const reason = upstreamError
            ? `Provider error: ${upstreamError}`
            : `Model stopped with reason "${response.stopReason}" before producing a usable response.`;
          throw new Error(`Model ${request.provider}/${request.model} failed. ${reason}`);
        }

        const totalTokens = response.usage?.totalTokens ?? 0;
        if (response.content.length === 0 && totalTokens === 0) {
          const details = upstreamError
            ? `Provider error: ${upstreamError}`
            : 'This model may be unavailable for your account. Try another model.';
          throw new Error(
            `Model ${request.provider}/${request.model} returned an empty response with zero tokens. `
            + details,
          );
        }

        if (!text.trim()) {
          const blockTypes = response.content.map((block) => block.type).join(', ') || 'none';
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

async function consumeStream(
  model: ReturnType<typeof getModel>,
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

function createContext(request: SpawnAgentRequest, prompt: LlmPromptInput): Context {
  const tools = request.toolset?.tools as Tool[] | undefined;
  const content = toUserContent(prompt);

  return {
    systemPrompt: request.systemPrompt,
    tools,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };
}

function toUserContent(prompt: LlmPromptInput): string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (typeof prompt === 'string') {
    return prompt;
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  for (const part of prompt) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
      continue;
    }

    content.push({
      type: 'image',
      data: part.data,
      mimeType: part.mimeType,
    });
  }

  return content;
}

async function executeWithOptionalTools(params: {
  model: ReturnType<typeof getModel>;
  context: Context;
  options: Record<string, unknown>;
  completionOptions?: LlmCompletionOptions;
  toolset?: LlmToolset;
  signal?: AbortSignal;
  onUsage: (usage: { input: number; output: number; cost: number }) => void;
}): Promise<AssistantMessage> {
  const {
    model,
    context,
    options,
    completionOptions,
    toolset,
    signal,
    onUsage,
  } = params;

  let round = 0;
  let previousRoundHadToolError = false;
  let toolErrorRecoveryAttempts = 0;
  for (;;) {
    round += 1;
    if (MAX_TOOL_ROUNDS !== undefined && round > MAX_TOOL_ROUNDS) {
      throw new Error(`Model exceeded ${MAX_TOOL_ROUNDS} tool rounds without producing a final response.`);
    }

    const response = await consumeStream(model, context, options, completionOptions);
    onUsage(getUsage(response));

    if (!toolset) {
      return response;
    }

    if (
      previousRoundHadToolError
      && (response.stopReason === 'error' || response.stopReason === 'aborted')
      && toolErrorRecoveryAttempts < 2
    ) {
      context.messages.push(response);

      const reason = response.errorMessage?.trim()
        ? response.errorMessage.trim()
        : `Model stopped with reason "${response.stopReason}" after a tool failure.`;

      context.messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Tool execution failed in the previous turn. Reason: ${reason}\n`
              + 'Do not stop. Inspect the failed tool result, correct the arguments, and retry the needed tool call(s).',
          },
        ],
        timestamp: Date.now(),
      });

      previousRoundHadToolError = false;
      toolErrorRecoveryAttempts += 1;
      continue;
    }

    toolErrorRecoveryAttempts = 0;

    const toolCalls = getToolCalls(response);
    if (toolCalls.length === 0) {
      return response;
    }

    context.messages.push(response);
    const { results: toolResults, hadErrors } = await executeToolCalls(
      toolset,
      context.tools ?? [],
      toolCalls,
      signal,
      completionOptions,
    );
    context.messages.push(...toolResults);
    previousRoundHadToolError = hadErrors;
  }
}

function resolveMaxToolRounds(): number | undefined {
  const raw = process.env.ORCHESTRACE_MAX_TOOL_ROUNDS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

async function executeToolCalls(
  toolset: LlmToolset,
  tools: Tool[],
  toolCalls: ToolCall[],
  signal?: AbortSignal,
  completionOptions?: LlmCompletionOptions,
): Promise<{ results: ToolResultMessage[]; hadErrors: boolean }> {
  const results: ToolResultMessage[] = [];
  let hadErrors = false;

  for (const toolCall of toolCalls) {
    let payload: { content: string; isError: boolean; details?: unknown };
    completionOptions?.onToolCall?.({
      type: 'started',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: formatToolPayload(toolCall.arguments),
    });

    try {
      const validatedArgs = validateToolCall(tools, toolCall) as Record<string, unknown>;
      const toolResult = await toolset.executeTool(
        {
          id: toolCall.id,
          name: toolCall.name,
          arguments: validatedArgs,
        },
        signal,
      );

      payload = {
        content: toolResult.content,
        isError: toolResult.isError ?? false,
        details: toolResult.details,
      };

      completionOptions?.onToolCall?.({
        type: 'result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: formatToolPayload(toolResult.content),
        isError: toolResult.isError ?? false,
      });
    } catch (error) {
      payload = {
        content: `Tool execution failed: ${toErrorMessage(error)}`,
        isError: true,
      };

      completionOptions?.onToolCall?.({
        type: 'result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: formatToolPayload(payload.content),
        isError: true,
      });
    }

    hadErrors = hadErrors || payload.isError;

    results.push({
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: 'text', text: payload.content }],
      details: payload.details,
      isError: payload.isError,
      timestamp: Date.now(),
    });
  }

  return { results, hadErrors };
}

function getToolCalls(message: AssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      calls.push(block);
    }
  }

  return calls;
}

function getUsage(message: AssistantMessage): { input: number; output: number; cost: number } {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cost: message.usage.cost.total,
  };
}

function handleStreamEvent(event: AssistantMessageEvent, completionOptions?: LlmCompletionOptions): void {
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

function normalizeModelEndpoint<TModel extends { provider?: string; baseUrl?: string }>(model: TModel): TModel {
  if (model.provider !== 'github-copilot') {
    return model;
  }

  const baseUrl = model.baseUrl ?? '';
  if (!baseUrl.includes('api.individual.githubcopilot.com')) {
    return model;
  }

  return {
    ...model,
    baseUrl: baseUrl.replace('api.individual.githubcopilot.com', 'api.githubcopilot.com'),
  };
}

function mergeUsage(
  target: { input: number; output: number; cost: number },
  incoming: { input: number; output: number; cost: number },
): void {
  target.input += incoming.input;
  target.output += incoming.output;
  target.cost += incoming.cost;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatToolPayload(value: unknown, maxChars = 8000): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... (truncated)` : text;
}

function resolveTimeoutMs(): number {
  const raw = process.env.ORCHESTRACE_LLM_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function createTimeoutSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!baseSignal && timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromBase = () => {
    controller.abort(baseSignal?.reason ?? new Error('LLM request aborted'));
  };

  if (baseSignal) {
    if (baseSignal.aborted) {
      abortFromBase();
    } else {
      baseSignal.addEventListener('abort', abortFromBase, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (baseSignal) {
        baseSignal.removeEventListener('abort', abortFromBase);
      }
    },
  };
}

function mapTimeoutError(error: unknown, timeoutMs: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('timed out') || message.toLowerCase().includes('abort')) {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }

  return error instanceof Error ? error : new Error(String(error));
}
