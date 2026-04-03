import {
  validateToolCall,
  type AssistantMessage,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';
import type { LlmCompletionOptions, LlmToolset } from '../types.js';
import { consumeStream, getUsage } from './stream.js';
import { formatToolPayload, toErrorMessage } from './utils.js';

const MAX_TOOL_ROUNDS = resolveMaxToolRounds();

export async function executeWithOptionalTools(params: {
  model: ReturnType<typeof import('@mariozechner/pi-ai').getModel>;
  context: import('@mariozechner/pi-ai').Context;
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
        content: [{
          type: 'text',
          text:
            `Tool execution failed in the previous turn. Reason: ${reason}\n`
            + 'Do not stop. Inspect the failed tool result, correct the arguments, and retry the needed tool call(s).',
        }],
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