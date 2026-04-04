import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateToolCall } from '@mariozechner/pi-ai';
import { consumeStream } from '../../src/adapter/stream.js';
import { executeWithOptionalTools } from '../../src/adapter/tools.js';

type TestMessage = {
  role: string;
  content?: Array<{ text?: string }>;
  isError?: boolean;
};

type TestContext = {
  messages: TestMessage[];
  tools: Array<{ name: string; description: string; parameters: { type: string } }>;
};

type ToolEvent = {
  type: 'started' | 'result';
  toolCallId: string;
  toolName: string;
  isError?: boolean;
};

vi.mock('../../src/adapter/stream.js', () => ({
  consumeStream: vi.fn(),
  getUsage: vi.fn(() => ({ input: 0, output: 0, cost: 0 })),
}));

vi.mock('@mariozechner/pi-ai', async () => ({
  validateToolCall: vi.fn((_tools, call) => call.arguments),
}));

function makeAssistantMessage(content: unknown[], stopReason = 'end_turn') {
  return {
    role: 'assistant',
    content,
    stopReason,
    usage: { input: 1, output: 1, cost: { total: 0 } },
    timestamp: Date.now(),
  };
}

describe('executeWithOptionalTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a retry prompt for each failed tool call', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);
    const validateToolCallMock = vi.mocked(validateToolCall);

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'run_command', arguments: { command: 'bad command 1' } },
      { type: 'toolCall', id: 'call-2', name: 'run_command', arguments: { command: 'bad command 2' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([
      { type: 'text', text: 'Recovered after retry.' },
    ]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'run_command', description: 'Run shell command', parameters: { type: 'object' } }],
    };

    const toolEvents: ToolEvent[] = [];

    const result = await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        async executeTool() {
          throw new Error('command not found: python');
        },
      },
      completionOptions: {
        onToolCall: (event) => toolEvents.push(event),
      },
      onUsage: () => {},
    });

    expect(result).toBe(finalResponse);
    expect(validateToolCallMock).toHaveBeenCalledTimes(2);

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(2);
    expect(toolResultMessages[0].isError).toBe(true);
    expect(toolResultMessages[1].isError).toBe(true);
    expect(toolResultMessages[0].content[0].text).toContain('command not found: python');
    expect(toolResultMessages[1].content[0].text).toContain('command not found: python');

    const retryPrompts = context.messages.filter(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry this tool call'),
    );
    expect(retryPrompts).toHaveLength(2);
    expect(retryPrompts[0].content[0].text).toContain('run_command (call-1)');
    expect(retryPrompts[1].content[0].text).toContain('run_command (call-2)');
    expect(retryPrompts[0].content[0].text).toContain('command not found: python');
    expect(retryPrompts[1].content[0].text).toContain('command not found: python');

    expect(toolEvents).toHaveLength(4);
    expect(toolEvents[0]).toMatchObject({ type: 'started', toolCallId: 'call-1', toolName: 'run_command' });
    expect(toolEvents[1]).toMatchObject({ type: 'result', toolCallId: 'call-1', toolName: 'run_command', isError: true });
    expect(toolEvents[2]).toMatchObject({ type: 'started', toolCallId: 'call-2', toolName: 'run_command' });
    expect(toolEvents[3]).toMatchObject({ type: 'result', toolCallId: 'call-2', toolName: 'run_command', isError: true });
  });

  it('does not inject retry prompt when tool call succeeds', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-2', name: 'run_command', arguments: { command: 'echo ok' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'All good.' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'run_command', description: 'Run shell command', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        async executeTool() {
          return { content: 'ok', isError: false };
        },
      },
      onUsage: () => {},
    });

    const retryPrompt = context.messages.find(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry'),
    );

    expect(retryPrompt).toBeUndefined();
  });
});
