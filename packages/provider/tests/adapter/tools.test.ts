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

    it('blocks read tool call immediately after sufficient-context acknowledgment until write_file is called', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      { type: 'text', text: 'I have enough source context to refactor safely.' },
      { type: 'toolCall', id: 'call-read', name: 'read_file', arguments: { path: 'src/a.ts' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const executeTool = vi.fn().mockResolvedValue({ content: 'should not run', isError: false });
    const context: TestContext = {
      messages: [],
      tools: [{ name: 'read_file', description: 'Read file', parameters: { type: 'object' } }],
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

    expect(executeTool).not.toHaveBeenCalled();
    const guardrailResult = context.messages.find(
      (message) => message.role === 'toolResult' && String(message.content?.[0]?.text ?? '').includes('blocked by system guardrail'),
    );
    expect(guardrailResult?.isError).toBe(true);
    expect(String(guardrailResult?.content?.[0]?.text ?? '')).toContain('next tool call must be write_file');
  });

  it('allows write_file immediately after sufficient-context acknowledgment', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      { type: 'text', text: 'I have enough source context to refactor safely.' },
      { type: 'toolCall', id: 'call-write', name: 'write_file', arguments: { path: 'src/a.ts', content: 'ok' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'All good.' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const executeTool = vi.fn().mockResolvedValue({ content: 'wrote', isError: false });
    const context: TestContext = {
      messages: [],
      tools: [{ name: 'write_file', description: 'Write file', parameters: { type: 'object' } }],
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

  it('uses deterministic remediation guidance for edit validation failures', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'edit-1', name: 'edit_file', arguments: { path: 'src/file.ts', oldText: 'x', newText: '\n' } },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Handled.' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'edit_file', description: 'Edit file', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        async executeTool() {
          return { content: 'Missing newText', isError: true };
        },
      },
      onUsage: () => {},
    });

    const deterministicPrompt = context.messages.find(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('This failure is deterministic.'),
    );
    expect(deterministicPrompt).toBeDefined();

    const genericRetryPrompt = context.messages.find(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry this tool call'),
    );
    expect(genericRetryPrompt).toBeUndefined();
  });

    it('splits duplicate-path edit_files batches into sequential single-file edit_files calls', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'edit-batch-dup',
        name: 'edit_files',
        arguments: {
          files: [
            { path: 'src/a.ts', oldText: 'one', newText: 'ONE' },
            { path: 'src/b.ts', oldText: 'two', newText: 'TWO' },
            { path: 'src/a.ts', oldText: 'three', newText: 'THREE' },
          ],
          concurrency: 4,
          adaptiveConcurrency: true,
          minConcurrency: 1,
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'done' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const executeTool = vi.fn()
      .mockResolvedValueOnce({
        isError: false,
        content: JSON.stringify({ total: 1, successes: 1, failures: 0, files: [{ path: 'src/a.ts', ok: true }] }),
      })
      .mockResolvedValueOnce({
        isError: false,
        content: JSON.stringify({ total: 1, successes: 1, failures: 0, files: [{ path: 'src/b.ts', ok: true }] }),
      })
      .mockResolvedValueOnce({
        isError: false,
        content: JSON.stringify({ total: 1, successes: 1, failures: 0, files: [{ path: 'src/a.ts', ok: true }] }),
      });

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'edit_files', description: 'Edit files in batch', parameters: { type: 'object' } }],
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

    const firstCall = executeTool.mock.calls[0]?.[0];
    const secondCall = executeTool.mock.calls[1]?.[0];
    const thirdCall = executeTool.mock.calls[2]?.[0];

    expect(firstCall.name).toBe('edit_files');
    expect(secondCall.name).toBe('edit_files');
    expect(thirdCall.name).toBe('edit_files');

    expect(firstCall.arguments.files).toEqual([{ path: 'src/a.ts', oldText: 'one', newText: 'ONE' }]);
    expect(secondCall.arguments.files).toEqual([{ path: 'src/b.ts', oldText: 'two', newText: 'TWO' }]);
    expect(thirdCall.arguments.files).toEqual([{ path: 'src/a.ts', oldText: 'three', newText: 'THREE' }]);

    expect(firstCall.arguments.concurrency).toBe(4);
    expect(firstCall.arguments.adaptiveConcurrency).toBe(true);
    expect(firstCall.arguments.minConcurrency).toBe(1);

    const toolResult = context.messages.find((message) => message.role === 'toolResult');
    expect(toolResult?.isError).toBe(false);
    const parsed = JSON.parse(String(toolResult?.content?.[0]?.text ?? '{}')) as {
      total: number;
      successes: number;
      failures: number;
      files: Array<{ path: string; ok: boolean }>;
    };
    expect(parsed.total).toBe(3);
    expect(parsed.successes).toBe(3);
    expect(parsed.failures).toBe(0);
    expect(parsed.files.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/a.ts']);
  });

  it('uses deterministic remediation guidance for duplicate-path edit_files errors', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'edit-dup-err',
        name: 'edit_files',
        arguments: {
          files: [
            { path: 'src/a.ts', oldText: 'one', newText: 'ONE' },
            { path: 'src/a.ts', oldText: 'two', newText: 'TWO' },
          ],
        },
      },
    ], 'tool_calls');
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Handled.' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'edit_files', description: 'Edit files in batch', parameters: { type: 'object' } }],
    };

    await executeWithOptionalTools({
      model: {} as never,
      context,
      options: {},
      toolset: {
        tools: [],
        async executeTool() {
          return { content: 'Duplicate paths are not allowed: src/a.ts', isError: true };
        },
      },
      onUsage: () => {},
    });

    const deterministicPrompt = context.messages.find(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('This failure is deterministic.'),
    );
    expect(deterministicPrompt).toBeDefined();

    const genericRetryPrompt = context.messages.find(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry this tool call'),
    );
    expect(genericRetryPrompt).toBeUndefined();
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

    const failurePayloadAttempt1 = JSON.stringify({
      failedNodeIds: ['graph_cli_task_entrypoint', 'graph_runner_session_flow'],
      runs: [
        { nodeId: 'graph_cli_task_entrypoint', status: 'failed', error: 'timeout a' },
        { nodeId: 'graph_runner_session_flow', status: 'failed', error: 'aborted a' },
      ],
    });
    const failurePayloadAttempt2 = JSON.stringify({
      failedNodeIds: ['graph_cli_task_entrypoint', 'graph_runner_session_flow'],
      runs: [
        { nodeId: 'graph_cli_task_entrypoint', status: 'failed', error: 'timeout b' },
        { nodeId: 'graph_runner_session_flow', status: 'failed', error: 'aborted b' },
      ],
    });
    const failurePayloadAttempt3 = JSON.stringify({
      failedNodeIds: ['graph_cli_task_entrypoint', 'graph_runner_session_flow'],
      runs: [
        { nodeId: 'graph_cli_task_entrypoint', status: 'failed', error: 'timeout c' },
        { nodeId: 'graph_runner_session_flow', status: 'failed', error: 'aborted c' },
      ],
    });

    const executeTool = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt1 })
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt2 })
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt3 });

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

  it('trips subagent batch circuit breaker on third identical failure and escalates', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-breaker',
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

    const toolResult = context.messages.find((message) => message.role === 'toolResult');
    const parsed = JSON.parse(String(toolResult?.content?.[0]?.text ?? '{}')) as {
      status: string;
      reason: string;
      failedNodeIds: string[];
      consecutiveIdenticalFailures: number;
      actionRequired: string;
    };

    expect(toolResult?.isError).toBe(true);
    expect(parsed.status).toBe('escalated_error');
    expect(parsed.reason).toBe('identical_subagent_batch_failures_repeated');
    expect(parsed.failedNodeIds).toEqual(['graph_cli_task_entrypoint', 'graph_runner_session_flow']);
    expect(parsed.consecutiveIdenticalFailures).toBe(3);
    expect(parsed.actionRequired).toContain('manual_intervention_or_backoff_before_retry');
  });

  it('continues subagent batch retries when failure signature changes between attempts', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      {
        type: 'toolCall',
        id: 'batch-changed-signature',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            { nodeId: 'n1', prompt: 'one' },
            { nodeId: 'n2', prompt: 'two' },
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
        content: JSON.stringify({ failedNodeIds: ['n1'], runs: [{ nodeId: 'n1', status: 'failed', error: 'timeout' }] }),
      })
      .mockResolvedValueOnce({
        isError: true,
        content: JSON.stringify({ failedNodeIds: ['n2'], runs: [{ nodeId: 'n2', status: 'failed', error: 'rate limit' }] }),
      })
      .mockResolvedValueOnce({ isError: false, content: JSON.stringify({ completed: 1, failed: 0 }) });

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
    expect(toolResult?.isError).toBeFalsy();
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

    const failurePayloadAttempt1 = JSON.stringify({
      failedNodeIds: ['research_source_scan', 'context_lookup'],
      runs: [
        { nodeId: 'research_source_scan', status: 'failed', error: 'timeout a' },
        { nodeId: 'context_lookup', status: 'failed', error: 'aborted a' },
      ],
    });
    const failurePayloadAttempt2 = JSON.stringify({
      failedNodeIds: ['research_source_scan', 'context_lookup'],
      runs: [
        { nodeId: 'research_source_scan', status: 'failed', error: 'timeout b' },
        { nodeId: 'context_lookup', status: 'failed', error: 'aborted b' },
      ],
    });
    const failurePayloadAttempt3 = JSON.stringify({
      failedNodeIds: ['research_source_scan', 'context_lookup'],
      runs: [
        { nodeId: 'research_source_scan', status: 'failed', error: 'timeout c' },
        { nodeId: 'context_lookup', status: 'failed', error: 'aborted c' },
      ],
    });

    const executeTool = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt1 })
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt2 })
      .mockResolvedValueOnce({ isError: true, content: failurePayloadAttempt3 });

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

    it('executes each tool call in multi-call responses to preserve call_id/result mapping', async () => {
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

    expect(executeTool).toHaveBeenCalledTimes(3);

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(3);
    expect(toolResultMessages[0].content?.[0]?.text).toBe('ok:call-1');
    expect(toolResultMessages[1].content?.[0]?.text).toBe('ok:call-2');
    expect(toolResultMessages[2].content?.[0]?.text).toBe('ok:call-3');
    expect(toolResultMessages[1].isError).toBe(false);
    expect(toolResultMessages[2].isError).toBe(false);
  });


    it('executes remaining tool calls even after one succeeds', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);
    const executeTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce({ content: 'fallback succeeded', isError: false })
      .mockResolvedValueOnce({ content: 'final fallback succeeded', isError: false });

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

    expect(executeTool).toHaveBeenCalledTimes(3);

    const toolResultMessages = context.messages.filter((message) => message.role === 'toolResult');
    expect(toolResultMessages).toHaveLength(3);
    expect(String(toolResultMessages[0].content?.[0]?.text ?? '')).toContain('primary failed');
    expect(toolResultMessages[0].isError).toBe(true);
    expect(toolResultMessages[1].content?.[0]?.text).toBe('fallback succeeded');
    expect(toolResultMessages[1].isError).toBe(false);
    expect(toolResultMessages[2].content?.[0]?.text).toBe('final fallback succeeded');

    const retryPrompts = context.messages.filter(
      (message) => message.role === 'user' && String(message.content?.[0]?.text ?? '').includes('retry this tool call'),
    );
    expect(retryPrompts).toHaveLength(1);
    expect(String(retryPrompts[0].content?.[0]?.text ?? '')).toContain('run_command (call-1)');
  });


      it('emits result event for each executed tool call without skipped markers', async () => {
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
    expect(String(toolResultMessages[1].content?.[0]?.text ?? '')).not.toContain('Skipped fallback tool call');
    expect(toolResultMessages[1].content?.[0]?.text).toBe('hello world');

    const secondResultEvent = toolEvents.find(
      (event) => event.type === 'result' && event.toolCallId === 'call-2',
    );
    expect(secondResultEvent).toMatchObject({
      type: 'result',
      toolCallId: 'call-2',
      toolName: 'run_command',
      isError: false,
    });
  });

  it('injects a corrective retry prompt when provider stops with missing tool-call mapping after tool errors', async () => {
    const consumeStreamMock = vi.mocked(consumeStream);

    const firstResponse = makeAssistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'run_command', arguments: { command: 'bad command' } },
    ], 'tool_calls');
    const providerErrorResponse = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'No tool call found for function call output with call_id call_123.',
      usage: { totalTokens: 10 },
      timestamp: Date.now(),
    };
    const finalResponse = makeAssistantMessage([{ type: 'text', text: 'Recovered after corrective prompt.' }]);

    consumeStreamMock.mockResolvedValueOnce(firstResponse as never);
    consumeStreamMock.mockResolvedValueOnce(providerErrorResponse as never);
    consumeStreamMock.mockResolvedValueOnce(finalResponse as never);

    const context: TestContext = {
      messages: [],
      tools: [{ name: 'run_command', description: 'Run shell command', parameters: { type: 'object' } }],
    };

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
      onUsage: () => {},
    });

    expect(result).toBe(finalResponse);
    const correctivePrompt = context.messages.find(
      (message) => message.role === 'user'
        && String(message.content?.[0]?.text ?? '').includes('Tool execution failed in the previous turn.'),
    );
    expect(correctivePrompt).toBeDefined();
    expect(String(correctivePrompt?.content?.[0]?.text ?? '')).toContain('No tool call found for function call output');
  });

});

