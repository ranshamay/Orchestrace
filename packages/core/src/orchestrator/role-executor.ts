import type {
  DagEvent,
  ModelConfig,
  ReplayAttemptRecord,
  ReplayFailureType,
  ReplayToolCallRecord,
  TaskOutput,
  TaskReplayRecord,
  TaskNode,
} from '../dag/types.js';
import { validate } from '../validation/validator.js';
import type {
  LlmAdapter,
  LlmAgent,
  LlmToolCallEvent,
  LlmToolset,
} from '@orchestrace/provider';
import { buildRoleSystemPrompt, buildRoleTaskPrompt, roleToPhase, type AgentRole } from './role-config.js';
import type { TaskEffort } from './task-complexity.js';

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

export async function executeImplementerRole(params: {
  task: TaskNode;
  graphId: string;
  depOutputs: Map<string, TaskOutput>;
  approvedPlan?: string;
  planPath?: string;
  effort: TaskEffort;
  implementationModel: ModelConfig;
  implAgent: LlmAgent;
  signal?: AbortSignal;
  cwd: string;
  emit: (event: DagEvent) => void;
  startTimeMs: number;
  taskTokenDumpDir: string;
  implementationTokenDumpPath: string;
  usage: { input: number; output: number; cost: number };
  replay: TaskReplayRecord;
  maxAttempts: number;
  appendTokenDump: (path: string, entry: {
    graphId: string;
    taskId: string;
    agent: 'planning' | 'implementation';
    attempt: number;
    provider: string;
    model: string;
    usage?: { input: number; output: number; cost: number };
  }) => Promise<void>;
}): Promise<TaskOutput> {
  const {
    task,
    graphId,
    depOutputs,
    approvedPlan,
    planPath,
    effort,
    implementationModel,
    implAgent,
    signal,
    cwd,
    emit,
    startTimeMs,
    taskTokenDumpDir,
    implementationTokenDumpPath,
    usage,
    replay,
    maxAttempts,
    appendTokenDump,
  } = params;

  let lastResponse = '';
  let lastFailureType: ReplayFailureType | undefined;
  let lastValidationError = '';
  let lastValidationResults = undefined as TaskOutput['validationResults'];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    emit({
      type: 'task:implementation-attempt',
      taskId: task.id,
      attempt,
      maxAttempts,
    });

    const implementationPrompt = buildRoleTaskPrompt({
      role: 'implementer',
      node: task,
      depOutputs,
      approvedPlan,
      attempt,
      previousResponse: lastResponse,
      previousFailureType: lastFailureType,
      previousValidationError: lastValidationError,
      effort,
    });

    const implementationToolCalls: ReplayToolCallRecord[] = [];
    const implementationAttemptStart = new Date().toISOString();
    let implResult;
    try {
      implResult = await executeRole({
        role: 'implementer',
        agent: implAgent,
        taskId: task.id,
        prompt: implementationPrompt,
        attempt,
        signal,
        emit,
        onToolCall: (_event, replayRecord) => {
          implementationToolCalls.push(replayRecord);
        },
      });
    } catch (error) {
      const failureType = resolveReplayFailureType(error);
      const implementationError = error instanceof Error ? error.message : String(error);
      const failedImplementationAttempt: ReplayAttemptRecord = {
        phase: 'implementation',
        attempt,
        startedAt: implementationAttemptStart,
        completedAt: new Date().toISOString(),
        provider: implementationModel.provider,
        model: implementationModel.model,
        reasoning: implementationModel.reasoning,
        error: implementationError,
        failureType,
        toolCalls: implementationToolCalls,
      };
      replay.attempts.push(failedImplementationAttempt);
      emit({
        type: 'task:replay-attempt',
        taskId: task.id,
        phase: 'implementation',
        attempt,
        record: failedImplementationAttempt,
      });

      if (attempt < maxAttempts && shouldRetryAfterCompletionFailure(failureType)) {
        lastFailureType = failureType;
        lastValidationError = buildCompletionFailureRetryHint({
          failureType,
          errorMessage: implementationError,
        });
        emit({
          type: 'task:verification-failed',
          taskId: task.id,
          attempt,
          error: `Retrying after ${failureType} failure: ${implementationError}`,
        });
        await delay(PLANNING_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
        continue;
      }

      return {
        taskId: task.id,
        status: 'failed',
        plan: approvedPlan,
        planPath,
        tokenDumpDir: taskTokenDumpDir,
        response: lastResponse,
        error: implementationError,
        failureType,
        durationMs: Date.now() - startTimeMs,
        retries: attempt - 1,
        usage,
        replay,
      };
    }

    const completedImplementationAttempt: ReplayAttemptRecord = {
      phase: 'implementation',
      attempt,
      startedAt: implementationAttemptStart,
      completedAt: new Date().toISOString(),
      provider: implementationModel.provider,
      model: implementationModel.model,
      reasoning: implementationModel.reasoning,
      stopReason: implResult.metadata?.stopReason,
      endpoint: implResult.metadata?.endpoint,
      usage: implResult.usage,
      textPreview: createTextPreview(implResult.text),
      toolCalls: implementationToolCalls,
    };
    replay.attempts.push(completedImplementationAttempt);
    emit({
      type: 'task:replay-attempt',
      taskId: task.id,
      phase: 'implementation',
      attempt,
      record: completedImplementationAttempt,
    });

    mergeUsage(usage, implResult.usage);
    await appendTokenDump(implementationTokenDumpPath, {
      graphId,
      taskId: task.id,
      agent: 'implementation',
      attempt,
      provider: implementationModel.provider,
      model: implementationModel.model,
      usage: implResult.usage,
    });
    lastResponse = implResult.text;

    const output: TaskOutput = {
      taskId: task.id,
      status: 'completed',
      plan: approvedPlan,
      planPath,
      tokenDumpDir: taskTokenDumpDir,
      response: implResult.text,
      filesChanged: implResult.filesChanged,
      durationMs: Date.now() - startTimeMs,
      retries: attempt - 1,
      usage,
      replay,
    };

    if (!task.validation) {
      return output;
    }

    emit({ type: 'task:validating', taskId: task.id });
    const validationResults = await validate(output, task.validation, cwd);
    output.validationResults = validationResults;
    lastValidationResults = validationResults;
    const allPassed = validationResults.every((result) => result.passed);
    completedImplementationAttempt.validation = {
      passed: allPassed,
      commandResults: validationResults.map((result) => ({
        command: result.command,
        passed: result.passed,
        output: result.output,
        durationMs: result.durationMs,
      })),
    };

    if (allPassed) {
      return output;
    }

    lastFailureType = 'validation';
    completedImplementationAttempt.failureType = 'validation';
    lastValidationError = validationResults
      .filter((result) => !result.passed)
      .map((result) => `${result.command}: ${result.output}`)
      .join('\n');

    emit({
      type: 'task:verification-failed',
      taskId: task.id,
      attempt,
      error: lastValidationError,
    });
  }

  return {
    taskId: task.id,
    status: 'failed',
    plan: approvedPlan,
    planPath,
    tokenDumpDir: taskTokenDumpDir,
    response: lastResponse,
    validationResults: lastValidationResults,
    error: lastValidationError || 'Implementation did not satisfy validation criteria.',
    failureType: lastFailureType ?? 'validation',
    durationMs: Date.now() - startTimeMs,
    retries: maxAttempts - 1,
    usage,
    replay,
  };
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

const PLANNING_RETRY_BASE_DELAY_MS = 2_000;

function mergeUsage(
  target: { input: number; output: number; cost: number },
  incoming?: { input: number; output: number; cost: number },
): void {
  if (!incoming) return;
  target.input += incoming.input;
  target.output += incoming.output;
  target.cost += incoming.cost;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTextPreview(text: string, maxChars = 600): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }

  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function resolveReplayFailureType(error: unknown): ReplayFailureType {
  if (error && typeof error === 'object' && 'failureType' in error) {
    const raw = (error as { failureType?: unknown }).failureType;
    if (isReplayFailureType(raw)) {
      return raw;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/(timed?\s*out|timeout|etimedout|abort)/.test(normalized)) {
    return 'timeout';
  }

  if (/(rate\s*limit|too many requests|quota|\b429\b)/.test(normalized)) {
    return 'rate_limit';
  }

  if (/(unauthorized|forbidden|invalid api key|auth|\b401\b|\b403\b)/.test(normalized)) {
    return 'auth';
  }

  if (/(invalid tool call|schema|validatetoolcall|invalid arguments|tool arguments)/.test(normalized)) {
    return 'tool_schema';
  }

  if (/(circuit breaker tripped|identical subagent batch failures repeated|manual intervention or explicit backoff is required)/.test(normalized)) {
    return 'validation';
  }

  if (/(tool execution failed|unknown tool|blocked command|not allowed while mode|tool failed)/.test(normalized)) {
    return 'tool_runtime';
  }

  if (/(empty response|no text output|zero tokens)/.test(normalized)) {
    return 'empty_response';
  }

  return 'unknown';
}

function isReplayFailureType(value: unknown): value is ReplayFailureType {
  return value === 'timeout'
    || value === 'auth'
    || value === 'rate_limit'
    || value === 'tool_schema'
    || value === 'tool_runtime'
    || value === 'validation'
    || value === 'empty_response'
    || value === 'unknown';
}

function shouldRetryAfterCompletionFailure(failureType: ReplayFailureType): boolean {
  return failureType === 'timeout'
    || failureType === 'rate_limit'
    || failureType === 'tool_runtime'
    || failureType === 'empty_response';
}

function buildCompletionFailureRetryHint(params: {
  failureType: ReplayFailureType;
  errorMessage: string;
}): string {
  switch (params.failureType) {
    case 'timeout':
      return [
        'Previous attempt failed due to timeout.',
        'Reduce scope per step, keep tool outputs concise, and continue from current state.',
        `Failure detail: ${params.errorMessage}`,
      ].join('\n');
    case 'rate_limit':
      return [
        'Previous attempt hit rate limits.',
        'Retry with fewer consecutive tool calls and prioritize essential steps first.',
        `Failure detail: ${params.errorMessage}`,
      ].join('\n');
    case 'tool_runtime':
      return [
        'Previous attempt failed during tool execution.',
        'Inspect prior tool-call errors, fix arguments/paths, and retry only needed tools.',
        `Failure detail: ${params.errorMessage}`,
      ].join('\n');
    case 'empty_response':
      return [
        'Previous attempt returned empty model output.',
        'Retry with concise reasoning and continue implementation from known plan context.',
        `Failure detail: ${params.errorMessage}`,
      ].join('\n');
    default:
      return `Previous attempt failed: ${params.errorMessage}`;
  }
}
