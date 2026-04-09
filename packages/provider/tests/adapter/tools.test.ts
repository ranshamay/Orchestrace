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

  it('retries subagent_spawn_batch failures in a single reduced batch request', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            { nodeId: 'graph_cli_task_entrypoint', prompt: 'one' },
            { nodeId: 'graph_runner_session_flow', prompt: 'two' },
            { nodeId: 'graph_docs', prompt: 'three' },
          ],
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const executeTool = vi.fn()
      .mockResolvedValueOnce({
        isError: true,
        content: JSON.stringify({
          failedNodeIds: ['graph_cli_task_entrypoint', 'graph_runner_session_flow'],
          runs: [
            { nodeId: 'graph_cli_task_entrypoint', status: 'failed' },
            { nodeId: 'graph_runner_session_flow', status: 'failed' },
            { nodeId: 'graph_docs', status: 'completed' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        isError: false,
        content: JSON.stringify({ completed: 2, failed: 0 }),
      });

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'subagent_spawn_batch', description: 'spawn many', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        executeTool,
      },
      onUsage: () => {},
    });

    expect(executeTool).toHaveBeenCalledTimes(2);

    const retryCall = executeTool.mock.calls[1]?.[0];
    expect(retryCall.name).toBe('subagent_spawn_batch');
    expect(retryCall.arguments).toMatchObject({
      agents: [
        {
          nodeId: 'graph_cli_task_entrypoint',
          prompt: 'one',
          contextPacket: {
            relevantContext: [
              expect.stringContaining('Retry context: prior sub-agent attempt failed for node "graph_cli_task_entrypoint"'),
            ],
          },
        },
        {
          nodeId: 'graph_runner_session_flow',
          prompt: 'two',
          contextPacket: {
            relevantContext: [
              expect.stringContaining('Retry context: prior sub-agent attempt failed for node "graph_runner_session_flow"'),
            ],
          },
        },
      ],
    });
    expect(retryCall.arguments.agents).not.toEqual(firstResponse.content[0].arguments.agents.slice(0, 2));
  });

  it('injects bounded generic retry context when failed runs omit explicit error', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-2',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            { nodeId: 'graph_retry_node', prompt: 'retry me' },
            { nodeId: 'graph_ok_node', prompt: 'ok' },
          ],
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const executeTool = vi.fn()
      .mockResolvedValueOnce({
        isError: true,
        content: JSON.stringify({
          runs: [
            { nodeId: 'graph_retry_node', status: 'failed' },
            { nodeId: 'graph_ok_node', status: 'completed' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        isError: false,
        content: JSON.stringify({ completed: 1, failed: 0 }),
      });

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'subagent_spawn_batch', description: 'spawn many', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        executeTool,
      },
      onUsage: () => {},
    });

    const retryCall = executeTool.mock.calls[1]?.[0];
    expect(retryCall.arguments).toMatchObject({
      agents: [
        {
          nodeId: 'graph_retry_node',
          contextPacket: {
            relevantContext: [
              expect.stringContaining('Retry context: prior sub-agent attempt failed for node "graph_retry_node".'),
            ],
          },
        },
      ],
    });
    const retryLine = retryCall.arguments.agents[0].contextPacket.relevantContext[0] as string;
    expect(retryLine).toContain('Retry context:');
    expect(retryLine.length).toBeLessThanOrEqual(360);
  });

  it('returns inline fallback for critical nodes after retry cap exhaustion', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-critical',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            { nodeId: 'graph_cli_task_entrypoint', prompt: 'critical node' },
            { nodeId: 'graph_runner_session_flow', prompt: 'critical node 2' },
          ],
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const failurePayload = JSON.stringify({
      failedNodeIds: ['graph_cli_task_entrypoint', 'graph_runner_session_flow'],
      runs: [
        { nodeId: 'graph_cli_task_entrypoint', status: 'failed', error: 'timeout' },
        { nodeId: 'graph_runner_session_flow', status: 'failed', error: 'aborted' },
      ],
    });

    const executeTool = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: failurePayload })
      .mockResolvedValueOnce({ isError: true, content: failurePayload })
      .mockResolvedValueOnce({ isError: true, content: failurePayload });

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'subagent_spawn_batch', description: 'spawn many', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        executeTool,
      },
      onUsage: () => {},
    });

    expect(executeTool).toHaveBeenCalledTimes(3);

    const toolResult = context.messages.find((message) => message.role === 'toolResult');
    expect(toolResult?.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult?.content?.[0]?.text ?? '{}')) as {
      status: string;
      retryCap: number;
      critical: string[];
      nonCritical: string[];
      inlineInstructions?: string;
    };
    expect(parsed.status).toBe('fallback');
    expect(parsed.retryCap).toBe(2);
    expect(parsed.critical).toEqual(['graph_cli_task_entrypoint', 'graph_runner_session_flow']);
    expect(parsed.nonCritical).toEqual([]);
    expect(parsed.inlineInstructions).toContain('Inline fallback required for critical nodes');
  });

  it('skips non-critical research nodes after retry cap exhaustion', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-noncritical',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            { nodeId: 'research_source_scan', prompt: 'non-critical node' },
            { nodeId: 'context_lookup', prompt: 'non-critical node 2' },
          ],
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const failurePayload = JSON.stringify({
      failedNodeIds: ['research_source_scan', 'context_lookup'],
      runs: [
        { nodeId: 'research_source_scan', status: 'failed', error: 'timeout' },
        { nodeId: 'context_lookup', status: 'failed', error: 'aborted' },
      ],
    });

    const executeTool = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: failurePayload })
      .mockResolvedValueOnce({ isError: true, content: failurePayload })
      .mockResolvedValueOnce({ isError: true, content: failurePayload });

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'subagent_spawn_batch', description: 'spawn many', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        executeTool,
      },
      onUsage: () => {},
    });

    const toolResult = context.messages.find((message) => message.role === 'toolResult');
    expect(toolResult?.isError).toBe(false);
    const parsed = JSON.parse(String(toolResult?.content?.[0]?.text ?? '{}')) as {
      status: string;
      retryCap: number;
      critical: string[];
      nonCritical: string[];
      warning?: string;
      skippedNodes?: string[];
    };
    expect(parsed.status).toBe('fallback');
    expect(parsed.retryCap).toBe(2);
    expect(parsed.critical).toEqual([]);
    expect(parsed.nonCritical).toEqual(['research_source_scan', 'context_lookup']);
    expect(parsed.skippedNodes).toEqual(['research_source_scan', 'context_lookup']);
    expect(parsed.warning).toContain('Skipped non-critical research nodes');
  });

  it('skips fallback tool calls after first successful call', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);
    const executeTool = vi.fn(async (call: { id: string }) => ({ content: `ok:${call.id}`, isError: false }));

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'run_command', arguments: { command: 'echo hello world' } },
      { type: 'toolCall', id: 'call-2', name: 'run_command', arguments: { command: '/bin/echo hello world' } },
      { type: 'toolCall', id: 'call-3', name: 'run_command', arguments: { command: 'printf "hello world\\n"' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Verified.' }]);

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
        executeTool,
      },
      onUsage: () => {},
    });

    expect(executeTool).toHaveBeenCalledTimes(1);

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(3);
    expect(toolResultMessages[0].content?.[0]?.text).toBe('ok:call-1');
    expect(String(toolResultMessages[1].content?.[0]?.text ?? '')).toContain('Skipped fallback tool call');
    expect(String(toolResultMessages[2].content?.[0]?.text ?? '')).toContain('Skipped fallback tool call');
    expect(toolResultMessages[1].isError).toBe(false);
    expect(toolResultMessages[2].isError).toBe(false);
  });

  it('executes next fallback when primary fails then stops after success', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);
    const executeTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce({ content: 'fallback succeeded', isError: false });

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'run_command', arguments: { command: 'echo hello world' } },
      { type: 'toolCall', id: 'call-2', name: 'run_command', arguments: { command: '/bin/echo hello world' } },
      { type: 'toolCall', id: 'call-3', name: 'run_command', arguments: { command: 'printf "hello world\\n"' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Recovered.' }]);

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
        executeTool,
      },
      onUsage: () => {},
    });

    expect(executeTool).toHaveBeenCalledTimes(2);

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(3);
    expect(String(toolResultMessages[0].content?.[0]?.text ?? '')).toContain('primary failed');
    expect(toolResultMessages[0].isError).toBe(true);
    expect(toolResultMessages[1].content?.[0]?.text).toBe('fallback succeeded');
    expect(toolResultMessages[1].isError).toBe(false);
    expect(String(toolResultMessages[2].content?.[0]?.text ?? '')).toContain('Skipped fallback tool call');

    const retryPrompts = context.messages.filter(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry this tool call'),
    );
    expect(retryPrompts).toHaveLength(1);
    expect(String(retryPrompts[0].content?.[0]?.text ?? '')).toContain('run_command (call-1)');
  });

  it('emits skipped marker for short-circuited fallback calls', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);
    const toolEvents: ToolEvent[] = [];

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'run_command', arguments: { command: 'echo hello world' } },
      { type: 'toolCall', id: 'call-2', name: 'run_command', arguments: { command: '/bin/echo hello world' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Done.' }]);

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
          return { content: 'hello world', isError: false };
        },
      },
      completionOptions: {
        onToolCall: (event) => toolEvents.push(event),
      },
      onUsage: () => {},
    });

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(2);
    expect(toolResultMessages[1].isError).toBe(false);
    expect(String(toolResultMessages[1].content?.[0]?.text ?? '')).toContain('Skipped fallback tool call');
    expect(toolResultMessages[1]).toMatchObject({
      details: { skipped: true, reason: 'prior_tool_call_succeeded' },
    });

    const skippedResultEvent = toolEvents.find(
      (event) => event.type === 'result' && event.toolCallId === 'call-2',
    );
    expect(skippedResultEvent).toMatchObject({
      type: 'result',
      toolCallId: 'call-2',
      toolName: 'run_command',
      isError: false,
    });
  });
});
