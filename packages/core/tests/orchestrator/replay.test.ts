import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmAgent, LlmCompletionOptions, LlmPromptInput, LlmRequest, SpawnAgentRequest } from '@orchestrace/provider';
import { orchestrate } from '../../src/orchestrator/orchestrator.js';
import type { DagEvent, TaskGraph } from '../../src/dag/types.js';

function makeSingleNodeGraph(params?: {
  prompt?: string;
  type?: 'code' | 'review' | 'test' | 'plan' | 'refactor' | 'custom';
}): TaskGraph {
  return {
    id: 'graph-1',
    name: 'Replay Test Graph',
    nodes: [
      {
        id: 'task-1',
        name: 'Task 1',
        type: params?.type ?? 'code',
        prompt: params?.prompt ?? 'Implement a tiny change.',
        dependencies: [],
      },
    ],
  };
}

function createAdapter(params: {
  planningThrows?: boolean;
  failImplementationOnceWithType?: 'timeout' | 'rate_limit' | 'tool_runtime' | 'empty_response';
  omitPlanningCoordination?: boolean;
  omitSubagentDelegation?: boolean;
  onPrompt?: (phase: 'planning' | 'implementation', prompt: LlmPromptInput) => void;
}): LlmAdapter {
  let implementationCalls = 0;

  async function spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const phase = request.systemPrompt === 'planning' ? 'planning' : 'implementation';

    return {
      complete: async (
        _prompt: LlmPromptInput,
        _signal?: AbortSignal,
        options?: LlmCompletionOptions,
      ) => {
        params.onPrompt?.(phase, _prompt);
        if (phase === 'planning') {
          if (!params.omitPlanningCoordination) {
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              arguments: '{"items":[{"id":"p1","title":"Plan","status":"todo","weight":60},{"id":"p2","title":"Validate","status":"in_progress","weight":40,"dependsOn":["p1"]}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-todo-1',
              toolName: 'todo_set',
              result: 'Stored 2 todo item(s).',
              isError: false,
            });
            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              arguments: '{"nodes":[{"id":"a1","name":"Inspect docs","prompt":"Inspect docs","weight":100}]}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'plan-graph-1',
              toolName: 'agent_graph_set',
              result: 'Stored agent dependency graph with 1 node(s).',
              isError: false,
            });
            if (!params.omitSubagentDelegation) {
              options?.onToolCall?.({
                type: 'started',
                toolCallId: 'plan-sub-1',
                toolName: 'subagent_spawn',
                arguments: '{"nodeId":"a1","prompt":"Summarize only relevant planner constraints"}',
              });
              options?.onToolCall?.({
                type: 'result',
                toolCallId: 'plan-sub-1',
                toolName: 'subagent_spawn',
                result: 'Sub-agent sub-1 completed.',
                isError: false,
              });
            }
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
  it('captures planning + implementation replay attempts on success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-success-'));
    const events: DagEvent[] = [];

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createAdapter({}),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
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
      // Planning now retries up to 3 times before giving up
      expect(output?.replay?.attempts.length).toBe(3);
      expect(output?.replay?.attempts.at(-1)?.failureType).toBe('validation');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('allows fast-path cleanup planning without subagent delegation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-fast-path-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph({
        prompt: 'Remove all references to useWorktree and clean up dead code. No functional change.',
        type: 'refactor',
      }), {
        llm: createAdapter({ omitSubagentDelegation: true }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(output?.replay?.attempts.length).toBe(2);
      const planningCalls = output?.replay?.attempts[0]?.toolCalls ?? [];
      expect(planningCalls.some((call) => call.toolName === 'todo_set' && call.status === 'result' && !call.isError)).toBe(true);
      expect(planningCalls.some((call) => call.toolName === 'agent_graph_set' && call.status === 'result' && !call.isError)).toBe(true);
      expect(planningCalls.some((call) => call.toolName === 'subagent_spawn' && call.status === 'result' && !call.isError)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('enforces full planning contract for complex tasks when subagent delegation is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-complex-fallback-'));

    try {
      const outputs = await orchestrate(makeSingleNodeGraph({
        prompt: 'Redesign architecture and migrate modules with a multi-step rollout.',
        type: 'code',
      }), {
        llm: createAdapter({ omitSubagentDelegation: true }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        createToolset: () => ({ tools: [], executeTool: async () => ({ content: 'noop' }) }),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('failed');
      expect(output?.failureType).toBe('validation');
      expect(output?.error).toContain('Planning contract not satisfied');
      expect(output?.error).toContain('subagent_spawn');
      expect(output?.replay?.attempts.length).toBe(3);
      expect(output?.replay?.attempts.at(-1)?.failureType).toBe('validation');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('includes mode-specific planning guidance in planning prompt', async () => {
    const fastCwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-prompt-fast-'));
    const fullCwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-plan-prompt-full-'));
    const fastPrompts: string[] = [];
    const fullPrompts: string[] = [];

    try {
      const fastOutputs = await orchestrate(makeSingleNodeGraph({
        prompt: 'Delete all references to useWorktree and cleanup leftovers.',
        type: 'refactor',
      }), {
        llm: createAdapter({
          onPrompt: (phase, prompt) => {
            if (phase === 'planning' && typeof prompt === 'string') {
              fastPrompts.push(prompt);
            }
          },
        }),
        cwd: fastCwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });
      expect(fastOutputs.get('task-1')?.status).toBe('completed');

      const fullOutputs = await orchestrate(makeSingleNodeGraph({
        prompt: 'Redesign architecture and migrate modules with a multi-step rollout.',
        type: 'code',
      }), {
        llm: createAdapter({
          onPrompt: (phase, prompt) => {
            if (phase === 'planning' && typeof prompt === 'string') {
              fullPrompts.push(prompt);
            }
          },
        }),
        cwd: fullCwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });
      expect(fullOutputs.get('task-1')?.status).toBe('completed');

      const fastPrompt = fastPrompts[0] ?? '';
      const fullPrompt = fullPrompts[0] ?? '';

      expect(fastPrompt).toContain('Planning Mode: fast');
      expect(fastPrompt).toContain('subagent_spawn/subagent_spawn_batch are optional in fast-path mode');
      expect(fastPrompt).not.toContain('subagent_spawn/subagent_spawn_batch (required)');

      expect(fullPrompt).toContain('Planning Mode: full');
      expect(fullPrompt).toContain('subagent_spawn/subagent_spawn_batch (required)');
      expect(fullPrompt).toContain('ALWAYS use subagent_spawn_batch (not individual subagent_spawn calls) when multiple independent sub-agents can run concurrently');
      expect(fullPrompt).not.toContain('subagent_spawn/subagent_spawn_batch are optional in fast-path mode');
    } finally {
      await rm(fastCwd, { recursive: true, force: true });
      await rm(fullCwd, { recursive: true, force: true });
    }
  }, 15_000);

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
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(capturedPlanningPrompts.length).toBeGreaterThan(0);
      const planningPrompt = capturedPlanningPrompts[0] ?? '';
      expect(planningPrompt).toContain('Decompose planning work into atomic tasks: each todo should represent one action and one completion outcome.');
      expect(planningPrompt).toContain('Never bundle multiple actions in one task; split broad work into smaller tasks before finalizing the plan.');
      expect(planningPrompt).toContain('If a task would take more than ~15 minutes or touches multiple independent areas, split it further.');
      expect(planningPrompt).toContain('3) per-stage atomic tasks with explicit dependencies and concurrency boundaries');
      expect(planningPrompt).toContain('8) atomic todo specification per task: {id, action, target, deps, verification, done_criteria}');
      expect(planningPrompt).toContain('9) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('forces transition to implementation when planning budget is exhausted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-planning-timeout-'));
    const events: DagEvent[] = [];

    const timeoutAdapter: LlmAdapter = {
      spawnAgent: async (request: SpawnAgentRequest): Promise<LlmAgent> => {
        const phase = request.systemPrompt === 'planning' ? 'planning' : 'implementation';
        return {
          complete: async (_prompt, _signal, options) => {
            if (phase === 'planning') {
              options?.onTextDelta?.('still planning...');
              await new Promise((resolve) => setTimeout(resolve, 25));
              return { text: 'late plan', usage: { input: 1, output: 1, cost: 0 } };
            }

            options?.onToolCall?.({
              type: 'started',
              toolCallId: 'impl-timeout-1',
              toolName: 'write_file',
              arguments: '{"path":"src/a.ts"}',
            });
            options?.onToolCall?.({
              type: 'result',
              toolCallId: 'impl-timeout-1',
              toolName: 'write_file',
              result: 'wrote file',
              isError: false,
            });
            return {
              text: 'Implemented after forced transition.',
              filesChanged: ['src/a.ts'],
              usage: { input: 1, output: 1, cost: 0 },
            };
          },
        };
      },
      complete: async () => ({ text: 'unused' }),
    };

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: timeoutAdapter,
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        planningPhaseBudgetMs: 5,
        planningAttemptTimeoutMs: 5,
        forceProceedOnPlanningTimeout: true,
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('completed');
      expect(output?.plan).toContain('Planning budget exhausted for task');
      expect(events.some((event) => event.type === 'task:warning' && event.code === 'PLANNING_TIMEOUT_FORCED_TRANSITION')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it('opens circuit breaker on too many non-progress events and fails safely', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-replay-circuit-breaker-'));
    const events: DagEvent[] = [];

    const noisyAdapter: LlmAdapter = {
      spawnAgent: async (request: SpawnAgentRequest): Promise<LlmAgent> => {
        const phase = request.systemPrompt === 'planning' ? 'planning' : 'implementation';
        return {
          complete: async (_prompt, _signal, options) => {
            if (phase === 'planning') {
              options?.onTextDelta?.('noise-1');
              options?.onTextDelta?.('noise-2');
              options?.onTextDelta?.('noise-3');
              return { text: 'noisy plan', usage: { input: 1, output: 1, cost: 0 } };
            }

            return { text: 'should not execute', usage: { input: 1, output: 1, cost: 0 } };
          },
        };
      },
      complete: async () => ({ text: 'unused' }),
    };

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: noisyAdapter,
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        maxNoProgressEvents: 2,
        onEvent: (event) => events.push(event),
      });

      const output = outputs.get('task-1');
      expect(output?.status).toBe('failed');
      expect(output?.failureType).toBe('budget_exhausted');
      expect(output?.error).toContain('circuit breaker opened');
      expect(events.some((event) => event.type === 'task:warning' && event.code === 'NO_PROGRESS_CIRCUIT_BREAKER')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
function createCacheExerciseAdapter(params: {
  implementationPrompt?: string;
  omitNodeIdInExecuteCall?: boolean;
} = {}): LlmAdapter {
  async function spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const phase = request.systemPrompt === 'planning' ? 'planning' : 'implementation';

    return {
      complete: async (_prompt, signal, options) => {
        const prompt = phase === 'implementation' && params.implementationPrompt
          ? params.implementationPrompt
          : 'shared prompt';

        const todoArgs = '{"items":[{"id":"p1","title":"Plan","status":"todo","weight":100}]}';
        const graphArgs = '{"nodes":[{"id":"a1","prompt":"Inspect","weight":100}]}';
        const subArgs = JSON.stringify({ nodeId: 'a1', prompt });

        options?.onToolCall?.({ type: 'started', toolCallId: `${phase}-todo`, toolName: 'todo_set', arguments: todoArgs });
        options?.onToolCall?.({ type: 'result', toolCallId: `${phase}-todo`, toolName: 'todo_set', arguments: todoArgs, result: 'Stored 1 todo item(s).', isError: false });
        options?.onToolCall?.({ type: 'started', toolCallId: `${phase}-graph`, toolName: 'agent_graph_set', arguments: graphArgs });
        options?.onToolCall?.({ type: 'result', toolCallId: `${phase}-graph`, toolName: 'agent_graph_set', arguments: graphArgs, result: 'Stored agent dependency graph with 1 node(s).', isError: false });
        options?.onToolCall?.({ type: 'started', toolCallId: `${phase}-sub`, toolName: 'subagent_spawn', arguments: subArgs });

        const execArgs = params.omitNodeIdInExecuteCall ? { prompt } : { nodeId: 'a1', prompt };
        const toolResult = await request.toolset?.executeTool({ id: `${phase}-sub`, name: 'subagent_spawn', arguments: execArgs }, signal);

        options?.onToolCall?.({
          type: 'result',
          toolCallId: `${phase}-sub`,
          toolName: 'subagent_spawn',
          arguments: subArgs,
          result: toolResult?.content ?? 'Sub-agent sub-1 completed.',
          isError: toolResult?.isError ?? false,
        });

        return {
          text: phase === 'planning' ? 'Plan complete.' : 'Implemented successfully.',
          usage: { input: 10, output: 5, cost: 0 },
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

describe('orchestrate sub-agent cache behavior', () => {
  it('reuses planning-phase sub-agent results in implementation for identical key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-cache-hit-'));
    let executionCount = 0;

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createCacheExerciseAdapter(),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        resolveWorkspaceGitSha: async () => 'sha-a',
        createToolset: () => ({
          tools: [],
          executeTool: async (call) => {
            if (call.name !== 'subagent_spawn') return { content: 'noop' };
            executionCount += 1;
            return { content: JSON.stringify({ id: `sub-${executionCount}`, status: 'completed', nodeId: call.arguments.nodeId }) };
          },
        }),
      });

      expect(outputs.get('task-1')?.status).toBe('completed');
      expect(executionCount).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('misses cache when prompt changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-cache-prompt-miss-'));
    let executionCount = 0;

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createCacheExerciseAdapter({ implementationPrompt: 'different prompt' }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        resolveWorkspaceGitSha: async () => 'sha-a',
        createToolset: () => ({
          tools: [],
          executeTool: async (call) => {
            if (call.name !== 'subagent_spawn') return { content: 'noop' };
            executionCount += 1;
            return { content: JSON.stringify({ id: `sub-${executionCount}`, status: 'completed', nodeId: call.arguments.nodeId }) };
          },
        }),
      });

      expect(outputs.get('task-1')?.status).toBe('completed');
      expect(executionCount).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('misses cache when workspace sha changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-cache-sha-miss-'));
    let executionCount = 0;

    try {
      const sharedToolset = () => ({
        tools: [],
        executeTool: async (call: { name: string; arguments: Record<string, unknown> }) => {
          if (call.name !== 'subagent_spawn') return { content: 'noop' };
          executionCount += 1;
          return { content: JSON.stringify({ id: `sub-${executionCount}`, status: 'completed', nodeId: call.arguments.nodeId }) };
        },
      });

      const first = await orchestrate(makeSingleNodeGraph(), {
        llm: createCacheExerciseAdapter(),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        resolveWorkspaceGitSha: async () => 'sha-a',
        createToolset: sharedToolset,
      });

      const second = await orchestrate(makeSingleNodeGraph(), {
        llm: createCacheExerciseAdapter(),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        resolveWorkspaceGitSha: async () => 'sha-b',
        createToolset: sharedToolset,
      });

      expect(first.get('task-1')?.status).toBe('completed');
      expect(second.get('task-1')?.status).toBe('completed');
      expect(executionCount).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('bypasses cache when nodeId is missing from execute call', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orchestrace-cache-nodeid-bypass-'));
    let executionCount = 0;

    try {
      const outputs = await orchestrate(makeSingleNodeGraph(), {
        llm: createCacheExerciseAdapter({ omitNodeIdInExecuteCall: true }),
        cwd,
        requirePlanApproval: false,
        planningSystemPrompt: 'planning',
        implementationSystemPrompt: 'implementation',
        resolveWorkspaceGitSha: async () => 'sha-a',
        createToolset: () => ({
          tools: [],
          executeTool: async (call) => {
            if (call.name !== 'subagent_spawn') return { content: 'noop' };
            executionCount += 1;
            return { content: JSON.stringify({ id: `sub-${executionCount}`, status: 'completed', nodeId: call.arguments.nodeId }) };
          },
        }),
      });

      expect(outputs.get('task-1')?.status).toBe('completed');
      expect(executionCount).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
