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
}): LlmAdapter {
  async function spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent> {
    const phase = request.systemPrompt === 'planning' ? 'planning' : 'implementation';

    return {
      complete: async (
        _prompt: LlmPromptInput,
        _signal?: AbortSignal,
        options?: LlmCompletionOptions,
      ) => {
        if (phase === 'planning') {
          options?.onToolCall?.({
            type: 'started',
            toolCallId: 'plan-1',
            toolName: 'read_file',
            arguments: '{"path":"README.md"}',
          });
          options?.onToolCall?.({
            type: 'result',
            toolCallId: 'plan-1',
            toolName: 'read_file',
            result: 'ok',
            isError: false,
          });

          if (params.planningThrows) {
            throw new Error('planning exploded');
          }

          return {
            text: 'Step 1: inspect files. Step 2: implement change.',
            usage: { input: 10, output: 5, cost: 0 },
            metadata: { stopReason: 'end_turn', endpoint: 'https://example.test' },
          };
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
      expect(output?.replay?.attempts[0]?.toolCalls.length).toBe(2);
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
      expect(output?.replay?.attempts[0]?.toolCalls.length).toBe(2);
      expect(output?.replay?.promptVersion.startsWith('custom-system-prompts-')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});