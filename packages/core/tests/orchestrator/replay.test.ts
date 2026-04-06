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

function createAdapter(params: {
  planningThrows?: boolean;
  failImplementationOnceWithType?: 'timeout' | 'rate_limit' | 'tool_runtime' | 'empty_response';
  omitPlanningCoordination?: boolean;
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
              arguments: '{"items":[{"id":"p1","title":"Plan","status":"in_progress"}]}',
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
              arguments: '{"nodes":[{"id":"a1","prompt":"Inspect docs"}]}',
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
              arguments: '{"prompt":"Summarize only relevant planner constraints"}',
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
      expect(planningPrompt).toContain('6) rollback/risk notes (required only when the plan includes file modifications or state-changing operations; otherwise state "N/A - read-only task")');
      // Phase-system heuristic guidance is validated via orchestrator source edits; planning prompt assertions stay scoped to planning prompt contract lines.
      expect(planningPrompt).toContain('8) atomic todo specification per task: {id, action, target, deps, verification, done_criteria}');
      expect(planningPrompt).toContain('9) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});