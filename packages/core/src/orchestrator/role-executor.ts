import type {
  DagEvent,
  ModelConfig,
  ReplayToolCallRecord,
  TaskNode,
} from '../dag/types.js';
import type {
  LlmAdapter,
  LlmAgent,
  LlmToolCallEvent,
  LlmToolset,
} from '@orchestrace/provider';
import { buildRoleSystemPrompt, type AgentRole } from './role-config.js';

export interface SpawnRoleAgentParams {
  llm: LlmAdapter;
  role: AgentRole;
  task: TaskNode;
  graphId: string;
  cwd: string;
  model: ModelConfig;
  systemPrompt?: string;
  signal?: AbortSignal;
  createToolset?: (params: {
    phase: 'planning' | 'implementation';
    task: TaskNode;
    graphId: string;
    cwd: string;
    provider: string;
    model: string;
    reasoning?: 'minimal' | 'low' | 'medium' | 'high';
    attempt?: number;
    taskRequiresWrites: boolean;
  }) => LlmToolset | undefined;
  resolveApiKey?: (provider: string) => Promise<string | undefined>;
  taskRequiresWrites: boolean;
}

export async function spawnRoleAgent(params: SpawnRoleAgentParams): Promise<LlmAgent> {
  const {
    llm,
    role,
    task,
    graphId,
    cwd,
    model,
    systemPrompt,
    signal,
    createToolset,
    resolveApiKey,
    taskRequiresWrites,
  } = params;

  const phase = roleToPhase(role);
  const apiKey = await resolveApiKey?.(model.provider);
  const refreshApiKey = resolveApiKey
    ? async () => resolveApiKey(model.provider)
    : undefined;

  return llm.spawnAgent({
    provider: model.provider,
    model: model.model,
    reasoning: model.reasoning,
    systemPrompt:
      systemPrompt
      ?? buildRoleSystemPrompt({
        role,
        task,
        graphId,
        cwd,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
      }),
    signal,
    toolset: createToolset?.({
      phase,
      task,
      graphId,
      cwd,
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      taskRequiresWrites,
    }),
    apiKey,
    refreshApiKey,
    allowAuthRefreshRetry: true,
  });
}

export async function executeRole(params: {
  role: AgentRole;
  agent: LlmAgent;
  taskId: string;
  prompt: string;
  attempt: number;
  signal?: AbortSignal;
  emit: (event: DagEvent) => void;
  onUsage?: (usage: { input: number; output: number; cost: number }) => void;
  onToolCall?: (event: LlmToolCallEvent, replayRecord: ReplayToolCallRecord) => void;
}): Promise<Awaited<ReturnType<LlmAgent['complete']>>> {
  const {
    role,
    agent,
    taskId,
    prompt,
    attempt,
    signal,
    emit,
    onUsage,
    onToolCall,
  } = params;

  const phase = roleToPhase(role);

  return agent.complete(prompt, signal, {
    onTextDelta: (delta) => {
      emit({
        type: 'task:stream-delta',
        taskId,
        phase,
        attempt,
        delta,
      });
    },
    onUsage,
    onToolCall: (event) => {
      const replayRecord = toReplayToolCallRecord(event);
      onToolCall?.(event, replayRecord);
      emit({
        type: 'task:tool-call',
        taskId,
        phase,
        attempt,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.type,
        input: event.arguments,
        output: event.result,
        isError: event.isError,
        details: event.details,
      });
    },
  });
}

function roleToPhase(role: AgentRole): 'planning' | 'implementation' {
  return role === 'planner' ? 'planning' : 'implementation';
}

function toReplayToolCallRecord(event: LlmToolCallEvent): ReplayToolCallRecord {
  return {
    time: new Date().toISOString(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.type,
    input: event.arguments,
    output: event.result,
    isError: event.isError,
    details: event.details,
  };
}
