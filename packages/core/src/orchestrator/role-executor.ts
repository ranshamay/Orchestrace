import type {
  DagEvent,
  ModelConfig,
  ReplayAttemptRecord,
  ReplayFailureType,
  ReplayToolCallRecord,
  TesterVerdict,
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
import {
  buildRoleSystemPrompt,
  buildRoleTaskPrompt,
  buildTesterPrompt,
  roleToPhase,
  type AgentRole,
} from './role-config.js';
import {
  buildCompletionFailureRetryHint,
  resolveReplayFailureType,
  shouldRetryAfterCompletionFailure,
} from './completion-retry-policy.js';
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
    role: AgentRole;
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
      role,
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
  postValidationGate?: (params: {
    task: TaskNode;
    attempt: number;
    output: TaskOutput;
    signal?: AbortSignal;
  }) => Promise<
    | { approved: true; output?: TaskOutput }
    | { approved: false; error: string }
  >;
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
    postValidationGate,
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
      if (!postValidationGate) {
        return output;
      }

      try {
        const gateResult = await postValidationGate({
          task,
          attempt,
          output,
          signal,
        });

        if (gateResult.approved) {
          return gateResult.output ?? output;
        }

        lastFailureType = 'validation';
        completedImplementationAttempt.failureType = 'validation';
        lastValidationError = gateResult.error || 'Post-validation gate rejected implementation.';

        emit({
          type: 'task:verification-failed',
          taskId: task.id,
          attempt,
          error: lastValidationError,
        });
        continue;
      } catch (error) {
        lastFailureType = 'validation';
        completedImplementationAttempt.failureType = 'validation';
        lastValidationError = `Post-validation gate failed: ${error instanceof Error ? error.message : String(error)}`;

        emit({
          type: 'task:verification-failed',
          taskId: task.id,
          attempt,
          error: lastValidationError,
        });
        continue;
      }
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

export interface ExecuteTesterRoleResult {
  verdict: TesterVerdict;
  usage?: { input: number; output: number; cost: number };
  responseText: string;
  toolCalls: ReplayToolCallRecord[];
}

export async function executeTesterRole(params: {
  task: TaskNode;
  approvedPlan?: string;
  implementationOutput: TaskOutput;
  testerAgent: LlmAgent;
  attempt: number;
  signal?: AbortSignal;
  emit: (event: DagEvent) => void;
  requireRunTests: boolean;
}): Promise<ExecuteTesterRoleResult> {
  const {
    task,
    approvedPlan,
    implementationOutput,
    testerAgent,
    attempt,
    signal,
    emit,
    requireRunTests,
  } = params;

  const testerPrompt = buildTesterPrompt({
    node: task,
    approvedPlan,
    implementationResponse: implementationOutput.response,
    changedFiles: implementationOutput.filesChanged,
    validationResults: implementationOutput.validationResults,
    attempt,
    previousFailureReason: undefined,
  });

  const toolCalls: ReplayToolCallRecord[] = [];
  const testCommandOutputs: string[] = [];
  let ranTestCommand = false;

  const result = await executeRole({
    role: 'tester',
    agent: testerAgent,
    taskId: task.id,
    prompt: testerPrompt,
    attempt,
    signal,
    emit,
    onToolCall: (event, replayRecord) => {
      toolCalls.push(replayRecord);

      const isTestCommandTool = event.toolName === 'run_command' || event.toolName === 'run_command_batch';
      if (isTestCommandTool && event.type === 'result') {
        ranTestCommand = true;
        if (typeof event.result === 'string' && event.result.trim().length > 0) {
          testCommandOutputs.push(event.result.trim());
        }
      }
    },
  });

  const parsedVerdict = parseTesterVerdict(result.text);
  const condensedOutput = collapseTesterOutput(testCommandOutputs);

  let verdict: TesterVerdict;
  if (requireRunTests && !ranTestCommand) {
    verdict = {
      approved: false,
      testsPassed: 0,
      testsFailed: 1,
      rejectionReason: 'Tester agent did not execute a test command (run_command or run_command_batch).',
      suggestedFixes: [
        'Run targeted tests with run_command before emitting a tester verdict.',
      ],
      testOutput: condensedOutput,
    };
  } else if (!parsedVerdict) {
    verdict = {
      approved: false,
      testsPassed: 0,
      testsFailed: 1,
      rejectionReason: 'Tester response did not include a valid JSON verdict.',
      suggestedFixes: [
        'End tester response with a valid JSON verdict object.',
      ],
      testOutput: condensedOutput,
    };
  } else {
    verdict = {
      ...parsedVerdict,
      approved: parsedVerdict.approved && parsedVerdict.testsFailed === 0,
      testOutput: condensedOutput,
    };
  }

  return {
    verdict,
    usage: result.usage,
    responseText: result.text,
    toolCalls,
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

function parseTesterVerdict(
  responseText: string,
): Omit<TesterVerdict, 'testOutput'> | null {
  const candidatePayloads = collectJsonCandidates(responseText);
  for (const candidate of candidatePayloads) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      const approved = parsed.approved === true;
      const testsPassed = toNonNegativeInt(parsed.testsPassed);
      const testsFailed = toNonNegativeInt(parsed.testsFailed);
      const rejectionReason = asOptionalString(parsed.rejectionReason);
      const suggestedFixes = asStringArray(parsed.suggestedFixes);

      return {
        approved,
        testsPassed,
        testsFailed,
        rejectionReason,
        suggestedFixes,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function collectJsonCandidates(responseText: string): string[] {
  const candidates: string[] = [];
  const trimmed = responseText.trim();
  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }

  const fencedMatches = [...responseText.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const firstBrace = responseText.indexOf('{');
  const lastBrace = responseText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(responseText.slice(firstBrace, lastBrace + 1).trim());
  }

  return dedupeStrings(candidates);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function collapseTesterOutput(outputs: string[]): string {
  if (outputs.length === 0) {
    return '(no test command output captured)';
  }

  const merged = outputs.join('\n\n---\n\n').trim();
  const maxChars = 16_000;
  if (merged.length <= maxChars) {
    return merged;
  }

  return `${merged.slice(0, maxChars)}\n... [truncated ${merged.length - maxChars} chars]`;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
