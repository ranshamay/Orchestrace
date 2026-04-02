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
  LlmRequest,
  LlmResult,
  SpawnAgentRequest,
  LlmCompletionOptions,
  LlmToolset,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOOL_ROUNDS = 24;

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
        prompt: string,
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

        const totalTokens = response.usage?.totalTokens ?? 0;
        if (response.content.length === 0 && totalTokens === 0) {
          throw new Error(
            `Model ${request.provider}/${request.model} returned an empty response with zero tokens. `
            + 'This model may be unavailable for your account. Try another model.',
          );
        }

        if (!text.trim()) {
          const blockTypes = response.content.map((block) => block.type).join(', ') || 'none';
          throw new Error(
            `Model ${request.provider}/${request.model} returned no text output (blocks: ${blockTypes}). `
            + 'Try another model.',
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

function createContext(request: SpawnAgentRequest, prompt: string): Context {
  const tools = request.toolset?.tools as Tool[] | undefined;

  return {
    systemPrompt: request.systemPrompt,
    tools,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  };
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

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await consumeStream(model, context, options, completionOptions);
    onUsage(getUsage(response));

    if (!toolset) {
      return response;
    }

    const toolCalls = getToolCalls(response);
    if (toolCalls.length === 0) {
      return response;
    }

    context.messages.push(response);
    const toolResults = await executeToolCalls(toolset, context.tools ?? [], toolCalls, signal);
    context.messages.push(...toolResults);
  }

  throw new Error(`Model exceeded ${MAX_TOOL_ROUNDS} tool rounds without producing a final response.`);
}

async function executeToolCalls(
  toolset: LlmToolset,
  tools: Tool[],
  toolCalls: ToolCall[],
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    let payload: { content: string; isError: boolean; details?: unknown };

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
    } catch (error) {
      payload = {
        content: `Tool execution failed: ${toErrorMessage(error)}`,
        isError: true,
      };
    }

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

  return results;
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
