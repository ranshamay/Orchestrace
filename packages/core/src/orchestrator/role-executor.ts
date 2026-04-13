import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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

const DEFAULT_UI_TEST_COMMAND_PATTERNS = [
  'playwright',
  'test:ui',
  '--ui',
  '@orchestrace/ui test',
];

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
  provider: string;
  model: string;
  systemPrompt: string;
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
    provider,
    model,
    systemPrompt,
    attempt,
    signal,
    emit,
    onUsage,
    onToolCall,
  } = params;

  const phase = roleToPhase(role);

  emit({
    type: 'task:llm-context',
    taskId,
    phase,
    attempt,
    snapshotId: randomUUID(),
    provider,
    model,
    systemPrompt,
    prompt,
  });

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
    onReasoningDelta: (delta) => {
      emit({
        type: 'task:stream-delta',
        taskId,
        phase,
        attempt,
        delta,
        isReasoning: true,
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
  implementationSystemPrompt: string;
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
    implementationSystemPrompt,
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
        provider: implementationModel.provider,
        model: implementationModel.model,
        systemPrompt: implementationSystemPrompt,
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
  testerModel: ModelConfig;
  testerSystemPrompt: string;
  attempt: number;
  signal?: AbortSignal;
  emit: (event: DagEvent) => void;
  requireRunTests: boolean;
  requireUiTests: boolean;
  requireUiScreenshots: boolean;
  minUiScreenshotCount: number;
  uiChangesDetected: boolean;
  uiTestCommandPatterns: string[];
  workspacePath: string;
}): Promise<ExecuteTesterRoleResult> {
  const {
    task,
    approvedPlan,
    implementationOutput,
    testerAgent,
    testerModel,
    testerSystemPrompt,
    attempt,
    signal,
    emit,
    requireRunTests,
    requireUiTests,
    requireUiScreenshots,
    minUiScreenshotCount,
    uiChangesDetected,
    uiTestCommandPatterns,
    workspacePath,
  } = params;

  const testerPrompt = buildTesterPrompt({
    node: task,
    approvedPlan,
    implementationResponse: implementationOutput.response,
    changedFiles: implementationOutput.filesChanged,
    validationResults: implementationOutput.validationResults,
    attempt,
    uiChangesDetected,
    uiTestsRequired: requireUiTests,
    screenshotEvidenceRequired: requireUiScreenshots,
    minScreenshotCount: minUiScreenshotCount,
    uiTestCommandPatterns,
    previousFailureReason: undefined,
  });

  const toolCalls: ReplayToolCallRecord[] = [];
  const testCommandOutputs: string[] = [];
  const executedTestCommands: string[] = [];
  const successfulTestCommands: string[] = [];
  const pendingCommandsByToolCallId = new Map<string, string[]>();
  let ranTestCommand = false;

  const result = await executeRole({
    role: 'tester',
    agent: testerAgent,
    taskId: task.id,
    prompt: testerPrompt,
    provider: testerModel.provider,
    model: testerModel.model,
    systemPrompt: testerSystemPrompt,
    attempt,
    signal,
    emit,
    onToolCall: (event, replayRecord) => {
      toolCalls.push(replayRecord);

      const isTestCommandTool = isTesterExecutionTool(event.toolName);
      if (isTestCommandTool && event.type === 'started') {
        const extractedCommands = extractTestCommandsFromToolCall(event.toolName, event.arguments);
        executedTestCommands.push(...extractedCommands);
        if (event.toolCallId) {
          pendingCommandsByToolCallId.set(event.toolCallId, extractedCommands);
        }
      }

      if (isTestCommandTool && event.type === 'result') {
        ranTestCommand = true;
        const extractedCommands = (event.toolCallId && pendingCommandsByToolCallId.get(event.toolCallId))
          ?? extractTestCommandsFromToolCall(event.toolName, event.arguments);
        if (!event.isError) {
          successfulTestCommands.push(...extractedCommands);
        }
        if (event.toolCallId) {
          pendingCommandsByToolCallId.delete(event.toolCallId);
        }
        if (typeof event.result === 'string' && event.result.trim().length > 0) {
          testCommandOutputs.push(event.result.trim());
        }
      }
    },
  });

  const parsedVerdict = parseTesterVerdict(result.text);
  const condensedOutput = collapseTesterOutput(testCommandOutputs);
  const mergedExecutedCommands = dedupeStrings(executedTestCommands);
  const mergedSuccessfulCommands = dedupeStrings(successfulTestCommands);
  const effectiveUiPatterns = uiTestCommandPatterns.length > 0
    ? uiTestCommandPatterns
    : DEFAULT_UI_TEST_COMMAND_PATTERNS;
  const uiTestCommandRan = hasUiTestCommandEvidence(mergedSuccessfulCommands, effectiveUiPatterns);

  const parsedScreenshotEvidence = await resolveScreenshotEvidence(
    parsedVerdict?.screenshotPaths ?? [],
    workspacePath,
  );
  const screenshotPaths = parsedScreenshotEvidence.existingPaths;

  let verdict: TesterVerdict;
  if (requireRunTests && !ranTestCommand) {
    verdict = {
      approved: false,
      testPlan: [],
      testedAreas: [],
      executedTestCommands: mergedExecutedCommands,
      testsPassed: 0,
      testsFailed: 1,
      coverageAssessment: 'Unavailable because no test command was executed.',
      qualityAssessment: 'Rejected: missing mandatory tester execution.',
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: uiTestCommandRan,
      screenshotPaths,
      rejectionReason:
        'Tester agent did not execute a test command (run_command, run_command_batch, or playwright_run).',
      suggestedFixes: [
        'Run targeted tests with run_command, run_command_batch, or playwright_run before emitting a tester verdict.',
      ],
      testOutput: condensedOutput,
    };
  } else if (!parsedVerdict) {
    verdict = {
      approved: false,
      testPlan: [],
      testedAreas: [],
      executedTestCommands: mergedExecutedCommands,
      testsPassed: 0,
      testsFailed: 1,
      coverageAssessment: 'Unavailable because tester verdict JSON was invalid.',
      qualityAssessment: 'Rejected: tester verdict format invalid.',
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: uiTestCommandRan,
      screenshotPaths,
      rejectionReason: 'Tester response did not include a valid JSON verdict.',
      suggestedFixes: [
        'End tester response with a valid JSON verdict object.',
      ],
      testOutput: condensedOutput,
    };
  } else if (parsedVerdict.testPlan.length === 0) {
    verdict = {
      ...parsedVerdict,
      executedTestCommands: mergeStringArrays(parsedVerdict.executedTestCommands, mergedExecutedCommands),
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: parsedVerdict.uiTestsRun || uiTestCommandRan,
      screenshotPaths,
      approved: false,
      testsFailed: Math.max(1, parsedVerdict.testsFailed),
      rejectionReason: 'Tester verdict is missing a concrete test plan.',
      suggestedFixes: [
        'Provide a concrete testPlan array before running tests.',
        'Tie test plan items to changed behavior and regression risks.',
      ],
      testOutput: condensedOutput,
    };
  } else if (!parsedVerdict.coverageAssessment || !parsedVerdict.qualityAssessment) {
    verdict = {
      ...parsedVerdict,
      executedTestCommands: mergeStringArrays(parsedVerdict.executedTestCommands, mergedExecutedCommands),
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: parsedVerdict.uiTestsRun || uiTestCommandRan,
      screenshotPaths,
      approved: false,
      testsFailed: Math.max(1, parsedVerdict.testsFailed),
      rejectionReason:
        'Tester verdict must include both coverageAssessment and qualityAssessment for this changeset.',
      suggestedFixes: [
        'Add coverageAssessment describing changed behavior coverage.',
        'Add qualityAssessment describing regression risk and code quality impact.',
      ],
      testOutput: condensedOutput,
    };
  } else if (requireUiTests && !uiTestCommandRan) {
    verdict = {
      ...parsedVerdict,
      executedTestCommands: mergeStringArrays(parsedVerdict.executedTestCommands, mergedExecutedCommands),
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: false,
      screenshotPaths,
      approved: false,
      testsFailed: Math.max(1, parsedVerdict.testsFailed),
      rejectionReason:
        'UI changes were detected but no successful UI test command execution evidence was found.',
      suggestedFixes: [
        'Run UI tests using run_command, run_command_batch, or playwright_run (for example, playwright or UI test suite commands).',
        'Include the executed UI test command(s) in executedTestCommands.',
      ],
      testOutput: condensedOutput,
    };
  } else if (requireUiScreenshots && screenshotPaths.length < minUiScreenshotCount) {
    verdict = {
      ...parsedVerdict,
      executedTestCommands: mergeStringArrays(parsedVerdict.executedTestCommands, mergedExecutedCommands),
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: parsedVerdict.uiTestsRun || uiTestCommandRan,
      screenshotPaths,
      approved: false,
      testsFailed: Math.max(1, parsedVerdict.testsFailed),
      rejectionReason:
        `UI changes require at least ${minUiScreenshotCount} screenshot evidence file(s); found ${screenshotPaths.length}.`,
      suggestedFixes: [
        `Capture at least ${minUiScreenshotCount} UI screenshots into repository-tracked image files (avoid .orchestrace/) and include their repository-relative paths in screenshotPaths.`,
        ...parsedScreenshotEvidence.missingPaths.slice(0, 5).map((path) => `Ensure screenshot file exists and is an image: ${path}`),
      ],
      testOutput: condensedOutput,
    };
  } else {
    verdict = {
      ...parsedVerdict,
      executedTestCommands: mergeStringArrays(parsedVerdict.executedTestCommands, mergedExecutedCommands),
      uiChangesDetected,
      uiTestsRequired: requireUiTests,
      uiTestsRun: parsedVerdict.uiTestsRun || uiTestCommandRan,
      screenshotPaths,
      approved:
        parsedVerdict.approved
        && parsedVerdict.testsFailed === 0
        && (!requireUiTests || uiTestCommandRan)
        && (!requireUiScreenshots || screenshotPaths.length >= minUiScreenshotCount),
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
    input: event.rawArguments ?? event.arguments,
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
      const testPlan = asStringArray(parsed.testPlan);
      const testedAreas = asStringArray(parsed.testedAreas);
      const executedTestCommands = asStringArray(parsed.executedTestCommands);
      const testsPassed = toNonNegativeInt(parsed.testsPassed);
      const testsFailed = toNonNegativeInt(parsed.testsFailed);
      const coverageAssessment = asOptionalString(parsed.coverageAssessment);
      const qualityAssessment = asOptionalString(parsed.qualityAssessment);
      const uiChangesDetected = asBoolean(parsed.uiChangesDetected, false);
      const uiTestsRequired = asBoolean(parsed.uiTestsRequired, false);
      const uiTestsRun = asBoolean(parsed.uiTestsRun, false);
      const screenshotPaths = asStringArray(parsed.screenshotPaths);
      const rejectionReason = asOptionalString(parsed.rejectionReason);
      const suggestedFixes = asStringArray(parsed.suggestedFixes);

      return {
        approved,
        testPlan,
        testedAreas,
        executedTestCommands,
        testsPassed,
        testsFailed,
        coverageAssessment,
        qualityAssessment,
        uiChangesDetected,
        uiTestsRequired,
        uiTestsRun,
        screenshotPaths,
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

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function mergeStringArrays(...values: string[][]): string[] {
  const merged: string[] = [];
  for (const list of values) {
    merged.push(...list);
  }
  return dedupeStrings(merged);
}

function extractTestCommandsFromToolCall(toolName: string, argumentsJson: string | undefined): string[] {
  const normalizedToolName = normalizeToolName(toolName);
  if (!argumentsJson || !isTesterExecutionTool(normalizedToolName)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  if (normalizedToolName === 'run_command') {
    const command = asOptionalString(record.command);
    return command ? [command] : [];
  }

  if (normalizedToolName === 'playwright_run') {
    const command = asOptionalString(record.command) ?? 'test';
    const args = asStringArray(record.args);
    const fullCommand = ['playwright', command, ...args].join(' ').trim();
    return fullCommand ? [fullCommand] : [];
  }
  const commands = record.commands;
  if (!Array.isArray(commands)) {
    return [];
  }

  const extracted: string[] = [];
  for (const entry of commands) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        extracted.push(trimmed);
      }
      continue;
    }

    if (entry && typeof entry === 'object') {
      const command = asOptionalString((entry as Record<string, unknown>).command);
      if (command) {
        extracted.push(command);
      }
    }
  }

  return dedupeStrings(extracted);
}

function hasUiTestCommandEvidence(commands: string[], patterns: string[]): boolean {
  if (commands.length === 0) {
    return false;
  }

  const normalizedPatterns = patterns
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern.length > 0);

  if (normalizedPatterns.length === 0) {
    return false;
  }

  return commands.some((command) => {
    const lower = command.toLowerCase();
    return normalizedPatterns.some((pattern) => lower.includes(pattern));
  });
}

async function resolveScreenshotEvidence(
  screenshotPaths: string[],
  workspacePath: string,
): Promise<{ existingPaths: string[]; missingPaths: string[] }> {
  const existingPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const rawPath of dedupeStrings(screenshotPaths)) {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      continue;
    }

    const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(workspacePath, trimmed);
    const repoRelativePath = relative(workspacePath, absolutePath).replace(/\\/g, '/');

    if (repoRelativePath.startsWith('..') || repoRelativePath.length === 0) {
      missingPaths.push(trimmed);
      continue;
    }

    if (
      repoRelativePath === '.orchestrace'
      || repoRelativePath.startsWith('.orchestrace/')
      || repoRelativePath === '.git'
      || repoRelativePath.startsWith('.git/')
    ) {
      missingPaths.push(repoRelativePath);
      continue;
    }
    if (!isScreenshotImagePath(repoRelativePath)) {
      missingPaths.push(repoRelativePath);
      continue;
    }

    try {
      await access(absolutePath);
      existingPaths.push(repoRelativePath);
    } catch {
      missingPaths.push(repoRelativePath);
    }
  }

  return {
    existingPaths: dedupeStrings(existingPaths),
    missingPaths: dedupeStrings(missingPaths),
  };
}

function isScreenshotImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return '';
  }

  const parts = trimmed.split('.');
  return (parts[parts.length - 1] ?? '').trim();
}

function isTesterExecutionTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === 'run_command'
    || normalized === 'run_command_batch'
    || normalized === 'playwright_run';
}
