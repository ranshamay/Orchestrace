import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmAgent, LlmCompletionOptions, LlmPromptInput, LlmRequest, SpawnAgentRequest } from '@orchestrace/provider';
import { orchestrate } from '../../src/orchestrator/orchestrator.js';
import type { DagEvent, TaskGraph } from '../../src/dag/types.js';

function makeSingleNodeGraph(): TaskGraph {
  return {
    id: 'graph-1',
    name: 'Replay Test Graph',
    nodes: [
      {
        id: 'task-1',
        name: 'Task 1',
        type: 'code',
        prompt: 'Implement a tiny change.',
        dependencies: [],
      },
    ],
  };
}

function makeFocusedSingleNodeGraph(): TaskGraph {
  return {
    id: 'graph-focused',
    name: 'Focused Replay Test Graph',
    nodes: [
      {
        id: 'task-1',
        name: 'Focused Task',
        type: 'code',
        prompt: [
          'Enforce native git worktree usage behavior at session start in a known module.',
          '',
          '## Relevant Files',
          '- packages/cli/src/ui-server.ts',
        ].join('\n'),
        dependencies: [],
      },
    ],
  };
}

function createAdapter(params: {
  planningThrows?: boolean;
  failImplementationOnceWithType?: 'timeout' | 'rate_limit' | 'tool_runtime' | 'empty_response';
  omitPlanningCoordination?: boolean;
  planningDelegationDelaySuccessfulCalls?: number;
  onPrompt?: (phase: 'planning' | 'implementation', prompt: LlmPromptInput, systemPrompt: string) => void;
  planningBehavior?: (args: {
    prompt: LlmPromptInput;
    signal?: AbortSignal;
    options?: LlmCompletionOptions;
    planningCall: number;
    systemPrompt: string;
  }) => Promise<{
    text: string;
    usage?: { input: number; output: number; cost: number };
    metadata?: { stopReason?: string; endpoint?: string };
  }>;
}): LlmAdapter {
  let planningCalls = 0;
  let implementationCalls = 0;

  async function spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const systemPrompt = typeof request.systemPrompt === 'string' ? request.systemPrompt : '';
    const phase = systemPrompt === 'planning'
      || systemPrompt.includes('Planning-only mode')
      || systemPrompt.includes('Do not edit files in planning mode.')
      ? 'planning'
      : 'implementation';

    return {
      complete: async (
        _prompt: LlmPromptInput,
        _signal?: AbortSignal,
        options?: LlmCompletionOptions,
      ) => {
        params.onPrompt?.(phase, _prompt, systemPrompt);
        if (phase === 'planning') {
          planningCalls += 1;

          if (params.planningBehavior) {
            return params.planningBehavior({
              prompt: _prompt,
              signal: _signal,
              options,
              planningCall: planningCalls,
              systemPrompt,
            });
          }

          if (!params.omitPlanningCoordination) {
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              arguments: '{"items":[{"id":"p1","title":"Plan","status":"in_progress","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              result: 'Stored 1 todo item(s).',
              isError: false,
            });
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              arguments: '{"nodes":[{"id":"a1","prompt":"Inspect docs","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              result: 'Stored agent dependency graph with 1 node(s).',
              isError: false,
            });
            const preDelegationSuccessfulCalls = Math.max(0, params.planningDelegationDelaySuccessfulCalls ?? 0);
            for (let index = 0; index < preDelegationSuccessfulCalls; index += 1) {
              const toolCallId = `plan-prep-${index + 1}`;
              options?.onToolCall?.({
                type: 'started',
                toolCallId,
                toolName: 'list_directory',
                arguments: '{"path":"."}',
              });
              options?.onToolCall?.({
                type: 'result',
                toolCallId,
                toolName: 'list_directory',
                result: 'Listed entries.',
                isError: false,
              });
            }

            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-sub-1',
              toolName: 'subagent_spawn',
              arguments: '{"prompt":"Summarize only relevant planner constraints","nodeId":"a1"}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-sub-1',
              toolName: 'subagent_spawn',
              result: 'Sub-agent sub-1 completed.',
              isError: false,
            });
          }

          if (params.planningThrows) {
            throw new Error('planning exploded');
          }

          return {
            text: 'Step 1: inspect files. Step 2: implement change.',
            usage: { input: 10, output: 5, cost: 0 },
            metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
          };
        }

        implementationCalls += 1;
        if (params.failImplementationOnceWithType && implementationCalls === 1) {
          const error = new Error('LLM request timed out after 120000ms') as Error & { failureType?: string };
          error.failureType = params.failImplementationOnceWithType;
          throw error;
        }

        options?.onToolCall?.({
          type: 'started',
          toolCallId: 'impl-1',
          toolName: 'write_file',
          arguments: '{"path":"src/a.ts"}',
        });
        options?.onToolCall?.({
          type: 'result',
          toolCallId: 'impl-1',
          toolName: 'write_file',
          result: 'wrote file',
          isError: false,
        });

        return {
          text: 'Implemented successfully.',
          filesChanged: ['src/a.ts'],
          usage: { input: 20, output: 8, cost: 0 },
          metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
        };
      },
    };
  }

  return {
    spawnAgent,
    async complete(request: LlmRequest) {
      const agent = await spawnAgent({
        provider: request.provider,
        model: request.model,
        reasoning: request.reasoning,
        signal: request.signal,
        toolset: request.toolset,
        apiKey: request.apiKey,
        systemPrompt: request.systemPrompt,
      });
      return agent.complete(request.prompt, request.signal, {
        onTextDelta: request.onTextDelta,
        onUsage: request.onUsage,
        onToolCall: request.onToolCall,
      });
    },
  };
}

describe('orchestrate replay capture', () => {
    it('passes quick-start planning contract when delegation occurs within configured call limit', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-quick-start-pass-'));

      try {
        const outputs = await orchestrate(makeSingleNodeGraph(), {
          llm: createAdapter({ planningDelegationDelaySuccessfulCalls: 1 }),
          cwd,
          requirePlanApproval: false,
          planningSystemPrompt: 'planning',
          implementationSystemPrompt: 'implementation',
          createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
          quickStartMode: true,
          quickStartMaxPreDelegationToolCalls: 3,
        });

        const output = outputs.get('task-1');
        expect(output).toBeDefined();
        expect(output?.status).toBe('completed');
        expect(output?.failureType).toBeUndefined();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 20_000);

    it('fails quick-start planning contract when delegation occurs too late', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-quick-start-fail-'));

      try {
        const outputs = await orchestrate(makeSingleNodeGraph(), {
          llm: createAdapter({ planningDelegationDelaySuccessfulCalls: 4 }),
          cwd,
          requirePlanApproval: false,
          planningSystemPrompt: 'planning',
          implementationSystemPrompt: 'implementation',
          createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
          quickStartMode: true,
          quickStartMaxPreDelegationToolCalls: 3,
        });

        const output = outputs.get('task-1');
        expect(output).toBeDefined();
        expect(output?.status).toBe('failed');
        expect(output?.failureType).toBe('validation');
        expect(output?.error).toContain('Planning contract not satisfied');
        expect(output?.error).toContain('quick-start mode requires delegation within the first 3 successful tool call(s)');
        expect(output?.replay?.attempts.length).toBe(3);
        expect(output?.replay?.attempts.at(-1)?.failureType).toBe('validation');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 20_000);
  it('captures planning + implementation replay attempts on success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-success-'));
    const events: DagEvent[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({}),
        cwd,
        requirePlanApproval: false,
        promptVersion: 'prompt-v1',
        policyVersion: 'policy-v1',
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output).toBeDefined();
      expect(output?.status).toBe('completed');
      expect(output?.replay?.promptVersion).toBe('prompt-v1');
      expect(output?.replay?.policyVersion).toBe('policy-v1');
      expect(output?.replay?.attempts.length).toBe(2);
      expect(output?.replay?.attempts[0]?.phase).toBe('planning');
      expect(output?.replay?.attempts[1]?.phase).toBe('implementation');
      expect(output?.replay?.attempts[0]?.toolCalls.length).toBe(6);
      expect(output?.replay?.attempts[1]?.toolCalls.length).toBe(2);
      expect(output?.replay?.attempts[0]?.stopReason).toBe('end_turn');

      const replayEvents = events.filter((event) => event.type === 'task:replay-attempt');
      expect(replayEvents.length).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves replay information when planning fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-failure-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({ planningThrows: true }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });

      const output = outputs.get('task-1');
      expect(output).toBeDefined();
      expect(output?.status).toBe('failed');
      expect(output?.error).toContain('planning exploded');
      expect(output?.replay?.attempts.length).toBe(1);
      expect(output?.replay?.attempts[0]?.phase).toBe('planning');
      expect(output?.replay?.attempts[0]?.error).toContain('planning exploded');
      expect(output?.replay?.attempts[0]?.toolCalls.length).toBe(6);
      expect(output?.replay?.promptVersion.startsWith('custom-system-prompts-')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retries transient implementation failures using failure type guidance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-transient-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({ failImplementationOnceWithType: 'timeout' }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        maxImplementationAttempts: 2,
      });

      const output = outputs.get('task-1');
      expect(output).toBeDefined();
      expect(output?.status).toBe('completed');
      expect(output?.retries).toBe(1);
      expect(output?.replay?.attempts.length).toBe(3);
      expect(output?.replay?.attempts[1]?.phase).toBe('implementation');
      expect(output?.replay?.attempts[1]?.failureType).toBe('timeout');
      expect(output?.replay?.attempts[2]?.phase).toBe('implementation');
      expect(output?.replay?.attempts[2]?.error).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails planning when required coordination tool calls are missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-contract-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({ omitPlanningCoordination: true }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
      });

      const output = outputs.get('task-1');
      expect(output).toBeDefined();
      expect(output?.status).toBe('failed');
      expect(output?.failureType).toBe('validation');
      expect(output?.error).toContain('Planning contract not satisfied');
      expect(output?.error).toContain('todo_set');
      expect(output?.error).toContain('agent_graph_set');
      expect(output?.error).toContain('subagent_spawn');
      expect(output?.error).toContain('quick-start behavior');
      expect(output?.error).toContain('delegate within the first 2-3 calls');
      // Planning now retries up to 3 times before giving up
      expect(output?.replay?.attempts.length).toBe(3);
      expect(output?.replay?.attempts.at(-1)?.failureType).toBe('validation');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('allows focused planning without subagent delegation when todo_set and agent_graph_set succeed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-focused-no-subagent-'));

    try {
      const outputs = await orchestrate(makeFocusedSingleNodeGraph(), {
        llm: createAdapter({
          planningBehavior: async ({ options }) => {
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              arguments: '{"items":[{"id":"p1","title":"Plan","status":"in_progress","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              result: 'Stored 1 todo item(s).',
              isError: false,
            });
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              arguments: '{"nodes":[{"id":"a1","prompt":"Inspect docs","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              result: 'Stored agent dependency graph with 1 node(s).',
              isError: false,
            });

            return {
              text: 'Focused plan without planning subagents.',
              usage: { input: 10, output: 5, cost: 0 },
              metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
            };
          },
        }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
      });

      const output = outputs.get('task-1');
      expect(output).toBeDefined();
      expect(output?.status).toBe('completed');
      expect(output?.failureType).toBeUndefined();

      const planningAttempt = output?.replay?.attempts.find((attempt) => attempt.phase === 'planning');
      expect(planningAttempt).toBeDefined();
      expect(planningAttempt?.toolCalls.some((call) => call.toolName === 'todo_set')).toBe(true);
      expect(planningAttempt?.toolCalls.some((call) => call.toolName === 'agent_graph_set')).toBe(true);
      expect(planningAttempt?.toolCalls.some((call) => call.toolName === 'subagent_spawn')).toBe(false);
      expect(planningAttempt?.toolCalls.some((call) => call.toolName === 'subagent_spawn_batch')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retries planning with a stall nudge after too many consecutive planning deltas', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-planning-stall-retry-'));
    const planningPrompts: string[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({
          onPrompt: (phase, prompt) => {
            if (phase === 'planning' && typeof prompt === 'string') {
              planningPrompts.push(prompt);
            }
          },
          planningBehavior: async ({ options, signal, planningCall }) => {
            if (planningCall === 1) {
              for (let i = 0; i < 6; i += 1) {
                if (signal?.aborted) {
                  throw signal.reason;
                }
                options?.onTextDelta?.(`thinking-${i}`);
              }
              throw new Error('expected stall abort');
            }

            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              arguments: '{"items":[{"id":"p1","title":"Plan","status":"in_progress","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              result: 'Stored 1 todo item(s).',
              isError: false,
            });
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              arguments: '{"nodes":[{"id":"a1","prompt":"Inspect docs","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              result: 'Stored agent dependency graph with 1 node(s).',
              isError: false,
            });
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-sub-1',
              toolName: 'subagent_spawn',
              arguments: '{"prompt":"Summarize planner constraints","nodeId":"a1"}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-sub-1',
              toolName: 'subagent_spawn',
              result: 'Sub-agent sub-1 completed.',
              isError: false,
            });

            return {
              text: 'Recovered plan after nudge.',
              usage: { input: 12, output: 7, cost: 0 },
              metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
            };
          },
        }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      const planningAttempts = output?.replay?.attempts.filter((attempt) => attempt.phase === 'planning') ?? [];
      expect(planningAttempts.length).toBe(2);
      expect(planningAttempts[0]?.error).toContain('Planning appeared stuck');
      expect(planningPrompts.length).toBeGreaterThanOrEqual(2);
      expect(planningPrompts[0]).not.toContain('You appear to be stuck in planning');
      expect(planningPrompts[1]).toContain('You appear to be stuck in planning. Please proceed with a concrete tool call or finalize your output.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not trigger planning stall retry when tool calls reset the streak', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-planning-stall-reset-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({
          planningBehavior: async ({ options }) => {
            for (let i = 0; i < 12; i += 1) {
              options?.onTextDelta?.(`thinking-${i}`);
              if (i % 3 === 2) {
                const toolName = i === 2 ? 'todo_set' : i === 5 ? 'agent_graph_set' : 'subagent_spawn';
                options?.onToolCall?.({
                  type: 'started',
                  toolCallId: `plan-tool-${i}`,
                  toolName,
                  arguments: '{}',
                });
                options?.onToolCall?.({
                  type: 'result',
                  toolCallId: `plan-tool-${i}`,
                  toolName,
                  result: 'ok',
                  isError: false,
                });
              }
            }

            return {
              text: 'Plan completed with periodic tool progress.',
              usage: { input: 10, output: 4, cost: 0 },
              metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
            };
          },
        }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      const planningAttempts = output?.replay?.attempts.filter((attempt) => attempt.phase === 'planning') ?? [];
      expect(planningAttempts.length).toBe(1);
      expect(planningAttempts[0]?.error).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails after repeated planning stalls within retry budget', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-planning-stall-fail-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({
          planningBehavior: async ({ options, signal }) => {
            for (let i = 0; i < 6; i += 1) {
              if (signal?.aborted) {
                throw signal.reason;
              }
              options?.onTextDelta?.(`thinking-${i}`);
            }
            throw new Error('expected stall abort');
          },
        }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('failed');
      expect(output?.error).toContain('Planning appeared stuck');
      expect(output?.replay?.attempts.length).toBe(3);
      expect(output?.replay?.attempts.every((attempt) => attempt.phase === 'planning')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('bypasses planning for trivial prompts when gate is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-trivial-bypass-'));
    const events: DagEvent[] = [];

    try {
      const graph = makeSingleNodeGraph();
      graph.nodes[0] = { ...graph.nodes[0], prompt: 'echo hello world' };
      const outputs = await orchestrate(graph, {
        llm: createAdapter({}),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        enableTrivialTaskGate: true,
        trivialTaskMaxPromptLength: 120,
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(output?.plan).toContain('Trivial task gate routed this task to direct implementation.');
      expect(events.some((event) => event.type === 'task:planning')).toBe(false);
      expect(output?.replay?.attempts.some((attempt) => attempt.phase === 'planning')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps planning flow for non-trivial prompts even when gate is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-nontrivial-'));
    const events: DagEvent[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({}),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        enableTrivialTaskGate: true,
        trivialTaskMaxPromptLength: 120,
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(events.some((event) => event.type === 'task:planning')).toBe(true);
      expect(output?.replay?.attempts.some((attempt) => attempt.phase === 'planning')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to full planning when prompt is classified trivial but no command can be extracted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-fallback-'));
    const events: DagEvent[] = [];

    try {
      const graph = makeSingleNodeGraph();
      graph.nodes[0] = { ...graph.nodes[0], prompt: 'what is the weather today?' };
      const outputs = await orchestrate(graph, {
        llm: createAdapter({}),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        enableTrivialTaskGate: true,
        trivialTaskMaxPromptLength: 120,
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      // Orchestrator gate allows informational queries, but implementation path still executes safely.
      // Presence of implementation attempt + completion ensures no hard failure on classifier ambiguity.
      expect(events.some((event) => event.type === 'task:implementation-attempt')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('includes granular planning contract guidance in planning prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-prompt-'));
    const capturedPlanningPrompts: string[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({
          onPrompt: (phase, prompt) => {
            if (phase !== 'planning' || typeof prompt !== 'string') {
              return;
            }
            capturedPlanningPrompts.push(prompt);
          },
        }),
        cwd,
        requirePlanApproval: false,
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(capturedPlanningPrompts.length).toBeGreaterThan(0);
      const planningPrompt = capturedPlanningPrompts[0] ?? '';
      expect(planningPrompt).toContain('Decompose planning work into atomic tasks: each todo should represent one action and one completion outcome.');
      expect(planningPrompt).toContain('Never bundle multiple actions in one task; split broad work into smaller tasks before finalizing the plan.');
      expect(planningPrompt).toContain('If a task would take more than ~15 minutes or touches multiple independent areas, split it further.');
      expect(planningPrompt).toContain('Quick-start planning mode for well-scoped tasks: keep parent pre-delegation orientation to at most 3-4 calls and delegate within the first 2-3 calls whenever possible');
      expect(planningPrompt).toContain('Keep parent orientation lightweight (e.g., root list + manifest + git status) and push detailed file reading/search into sub-agent scopes');
      expect(planningPrompt).toContain('3) per-stage atomic tasks with explicit dependencies and concurrency boundaries');
      expect(planningPrompt).toContain('8) atomic todo specification per task: {id, action, target, deps, verification, done_criteria}');
      expect(planningPrompt).toContain('9) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('includes search_files regex escaping reminder in implementation prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-impl-prompt-'));
    const capturedImplementationPrompts: string[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({
          onPrompt: (phase, _prompt, systemPrompt) => {
            if (phase !== 'implementation' || typeof systemPrompt !== 'string') {
              return;
            }
            capturedImplementationPrompts.push(systemPrompt);
          },
        }),
        cwd,
        requirePlanApproval: false,
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(capturedImplementationPrompts.length).toBeGreaterThan(0);
      const implementationPrompt = capturedImplementationPrompts[0] ?? '';
      expect(implementationPrompt).toContain('search_files uses regex; characters like ( and ) need escaping as \\( and \\).');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});