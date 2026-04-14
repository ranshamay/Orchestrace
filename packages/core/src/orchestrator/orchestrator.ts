import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  TaskGraph,
  TaskNode,
  TaskOutput,
  RunnerConfig,
  ModelConfig,
  ReplayAttemptRecord,
  ReplayToolCallRecord,
  TaskReplayRecord,
} from '../dag/types.js';
import type { TaskExecutionContext } from '../dag/scheduler.js';
import { runDag } from '../dag/scheduler.js';
import type { LlmAdapter, LlmToolset } from '@orchestrace/provider';
import { classifyTrivialTaskNode, classifyTaskEffort, resolveTrivialTaskGateConfig } from './task-complexity.js';
import type { TaskEffort } from './task-complexity.js';
import {
  PLANNING_FIRST_TOOL_RETRY_DIRECTIVE,
  buildRoleTaskPrompt,
  buildRoleSystemPrompt,
} from './role-config.js';
import {
  executeImplementerRole,
  executeRole,
  executeTesterRole,
  spawnRoleAgent,
} from './role-executor.js';
import {
  resolveReplayFailureType,
  shouldRetryAfterCompletionFailure,
} from './completion-retry-policy.js';
import {
  buildPlanningContractError,
  createPlanningContractFailureSignature,
} from './planning-contract.js';
import {
  type PlanningNoToolGuardMode,
  PLANNING_NO_TOOL_INITIAL_CUTOFF_MS,
  PLANNING_NO_TOOL_PROGRESS_CHECK_INTERVAL_MS,
  PLANNING_NO_TOOL_PROGRESS_NUDGE,
  PLANNING_NO_TOOL_PROGRESS_TIMEOUT_MS,
  PLANNING_PRE_FIRST_TOOL_TOKEN_ABORT_BUDGET,
  PLANNING_PRE_FIRST_TOOL_TOKEN_NUDGE_BUDGET,
  createPlanningNoProgressAbortError,
  isPlanningNoProgressAbortError,
  normalizePlanningNoToolGuardMode,
} from './planning-no-progress-guard.js';

export interface PlanApprovalRequest {
  task: TaskNode;
  plan: string;
  planPath: string;
}

export interface OrchestratorConfig extends RunnerConfig {
  /** LLM adapter for executing agent tasks. */
  llm: LlmAdapter;
  /** Working directory for validation commands. */
  cwd: string;
  /** System prompt for planning calls. */
  planningSystemPrompt?: string;
  /** System prompt for implementation calls. */
  implementationSystemPrompt?: string;
  /** Backwards-compatible default system prompt. */
  systemPrompt?: string;
  /** Optional default model for planning phase when a task does not override model. */
  defaultPlanningModel?: ModelConfig;
  /** Optional default model for implementation phase when a task does not override model. */
  defaultImplementationModel?: ModelConfig;
  /** Directory for persisted plans. Defaults to <cwd>/.orchestrace/plans. */
  planOutputDir?: string;
  /** Require user approval before implementation. Defaults to true. */
  requirePlanApproval?: boolean;
  /** Callback used to approve/reject persisted plans. */
  onPlanApproval?: (request: PlanApprovalRequest) => Promise<boolean>;
  /** Optional provider auth resolver (env, OAuth store, secret manager, etc.). */
  resolveApiKey?: (provider: string) => Promise<string | undefined>;
  /** Optional tester gate configuration for implementation outputs. */
  testerConfig?: {
    enabled: boolean;
    model?: ModelConfig;
    systemPrompt?: string;
    requireRunTests?: boolean;
    enforceUiTestsForUiChanges?: boolean;
    requireUiScreenshotsForUiChanges?: boolean;
    minUiScreenshotCount?: number;
    uiChangePatterns?: string[];
    uiTestCommandPatterns?: string[];
  };
  /** Optional default model for tester phase when a task does not override model. */
  defaultTesterModel?: ModelConfig;
  /** Optional factory for phase-specific agent tools. */
  createToolset?: (params: {
    role: 'planner' | 'implementer' | 'tester';
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
  /** Max implementation attempts per task. Defaults to validation.maxRetries + 1. */
  maxImplementationAttempts?: number;
  /** Directory for per-agent token dumps. Defaults to <cwd>/.orchestrace/tokens. */
  tokenDumpDir?: string;
  /** Replay prompt version tag persisted into task outputs. */
  promptVersion?: string;
  /** Replay policy version tag persisted into task outputs. */
  policyVersion?: string;
  /** Enables conservative pre-planning trivial-task classification gate. */
  enableTrivialTaskGate?: boolean;
  /** Max normalized prompt length for trivial-task classification. */
  trivialTaskMaxPromptLength?: number;
  /** Enable quick-start planning mode that enforces early delegation. Defaults to false. */
  quickStartMode?: boolean;
  /** Max successful tool calls allowed before first successful sub-agent delegation. Defaults to 3 when quick-start is enabled. */
  quickStartMaxPreDelegationToolCalls?: number;
  /** Abort a planning attempt only after prolonged no-tool progress. Defaults to 5 minutes. */
  planningNoToolProgressTimeoutMs?: number;
  /** Polling interval used for planning no-tool progress checks. Defaults to 1 second. */
  planningNoToolProgressCheckIntervalMs?: number;
    /** Controls whether planning no-tool guards abort attempts (`enforce`) or emit warnings only (`warn`). */
  planningNoToolGuardMode?: 'enforce' | 'warn';
  /** Max successful planning tool calls allowed per planning attempt before forcing convergence. Defaults to 12. */
  maxPlanningToolCallsPerAttempt?: number;
  /** Override task effort classification. When set, controls execution strategy:
   *  trivial/low = skip planning; medium = sub-agents optional; high = full orchestration. */
  taskEffort?: TaskEffort;
}

const DEFAULT_ORCHESTRATOR_PROMPT_VERSION = 'orchestrator-prompts-v2';
const MAX_PLANNING_ATTEMPTS = 3;
const DEFAULT_MAX_PLANNING_TOOL_CALLS_PER_ATTEMPT = 30;

const PLANNING_RETRY_BASE_DELAY_MS = 2_000;
const PLANNING_NO_TOOL_STAGNATION_ABORT_ATTEMPTS = 2;
const PLANNING_CONTRACT_STAGNATION_ABORT_ATTEMPTS = 2;
const PLANNING_CONTRACT_STAGNATION_ERROR_PREFIX =
  'Planning stagnated across attempts with no phase advancement.';

/**
 * High-level orchestrator that wires the DAG scheduler to the LLM provider
 * and validation system.
 *
 * Flow per task: prompt LLM → collect output → validate → retry or complete.
 */
export async function orchestrate(
  graph: TaskGraph,
  config: OrchestratorConfig,
): Promise<Map<string, TaskOutput>> {
  const {
    llm,
    cwd,
    systemPrompt,
    defaultPlanningModel,
    defaultImplementationModel,
    planningSystemPrompt,
    implementationSystemPrompt,
    planOutputDir,
    tokenDumpDir,
    requirePlanApproval,
    onPlanApproval,
    resolveApiKey,
    createToolset,
    testerConfig,
    defaultTesterModel,
    maxImplementationAttempts,
    onEvent,
    promptVersion,
    policyVersion,
    enableTrivialTaskGate,
    trivialTaskMaxPromptLength,
    quickStartMode,
    quickStartMaxPreDelegationToolCalls,
        planningNoToolProgressTimeoutMs,
    planningNoToolProgressCheckIntervalMs,
    planningNoToolGuardMode,
    maxPlanningToolCallsPerAttempt,
    taskEffort: configTaskEffort,
  } = config;

  const emit = onEvent ?? (() => {});
  const resolvedMaxPlanningToolCallsPerAttempt = sanitizeMaxPlanningToolCallsPerAttempt(
    maxPlanningToolCallsPerAttempt,
  );

  const originalNodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const resolvedPromptVersion = resolvePromptVersion({
    explicitVersion: promptVersion,
    systemPrompt,
    planningSystemPrompt,
    implementationSystemPrompt,
  });

  // Scheduler retries are disabled because retries are managed inside the
  // plan -> approve -> implement -> verify loop for each task.
  const managedRetryGraph: TaskGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      validation: node.validation
        ? {
            ...node.validation,
            maxRetries: 0,
          }
        : undefined,
    })),
  };

  const executor = async (
    scheduledNode: TaskNode,
    context: TaskExecutionContext,
  ): Promise<TaskOutput> => {
    const start = Date.now();
    const node = originalNodesById.get(scheduledNode.id) ?? scheduledNode;

    const fallbackModel: ModelConfig = node.model ?? context.defaultModel ?? {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };
    const planningModel: ModelConfig = node.model ?? defaultPlanningModel ?? fallbackModel;
    const implementationModel: ModelConfig = node.model ?? defaultImplementationModel ?? fallbackModel;

    const usage = { input: 0, output: 0, cost: 0 };
    const replay: TaskReplayRecord = {
      version: 1,
      graphId: graph.id,
      taskId: node.id,
      promptVersion: resolvedPromptVersion,
      policyVersion: policyVersion ?? 'default-v1',
      provider: implementationModel.provider,
      model: implementationModel.model,
      reasoning: implementationModel.reasoning,
      attempts: [],
    };
    const taskTokenDumpDir = join(
      tokenDumpDir ?? join(cwd, '.orchestrace', 'tokens'),
      sanitizeForPath(graph.id),
      sanitizeForPath(node.id),
    );
    const planningTokenDumpPath = join(taskTokenDumpDir, 'planning.jsonl');
    const implementationTokenDumpPath = join(taskTokenDumpDir, 'implementation.jsonl');
    const testerTokenDumpPath = join(taskTokenDumpDir, 'testing.jsonl');

    const trivialTaskGate = resolveTrivialTaskGateConfig({
      enabled: enableTrivialTaskGate,
      maxPromptLength: trivialTaskMaxPromptLength,
    });
    const trivialClassification = classifyTrivialTaskNode(node, trivialTaskGate);
    const taskRequiresWrites = resolveTaskRequiresWrites(node);

    // Resolve effective effort: explicit config > prompt classification
    const effortClassification = classifyTaskEffort(node.prompt);
    const effort: TaskEffort = configTaskEffort ?? effortClassification.effort;
    // Always run planner for code tasks so the LLM can produce a full test-aware plan.
    // Non-code tasks may still use the trivial/low effort bypass.
    const shouldSkipPlanning =
      node.type !== 'code'
      && (trivialClassification.isTrivial || effort === 'trivial' || effort === 'low');

    let planningResult:
      | { text: string; usage?: { input: number; output: number; cost: number }; metadata?: { stopReason?: string; endpoint?: string } }
      | undefined;
    let persistedPlanPath: string | undefined;
    const resolvedPlanningNoToolGuardMode = normalizePlanningNoToolGuardMode(planningNoToolGuardMode);
    const resolvedPlanningSystemPrompt =
      planningSystemPrompt
      ?? systemPrompt
      ?? buildRoleSystemPrompt({
        role: 'planner',
        task: node,
        graphId: graph.id,
        cwd,
        provider: planningModel.provider,
        model: planningModel.model,
        reasoning: planningModel.reasoning,
      });
    const resolvedImplementationSystemPrompt =
      implementationSystemPrompt
      ?? systemPrompt
      ?? buildRoleSystemPrompt({
        role: 'implementer',
        task: node,
        graphId: graph.id,
        cwd,
        provider: implementationModel.provider,
        model: implementationModel.model,
        reasoning: implementationModel.reasoning,
      });

    if (!shouldSkipPlanning) {
      const planningAgent = await spawnRoleAgent({
        llm,
        role: 'planner',
        task: node,
        graphId: graph.id,
        cwd,
        model: planningModel,
        systemPrompt: resolvedPlanningSystemPrompt,
        signal: context.signal,
        createToolset,
        resolveApiKey,
        taskRequiresWrites,
      });

      emit({ type: 'task:planning', taskId: node.id });

      let planningToolCalls: ReplayToolCallRecord[] = [];
      let consecutiveNoToolStagnationAttempts = 0;
      let previousPlanningContractSignature: string | undefined;
      let consecutivePlanningContractStagnationAttempts = 0;

      for (let planningAttempt = 1; planningAttempt <= MAX_PLANNING_ATTEMPTS; planningAttempt++) {
        const planningPrompt = buildRoleTaskPrompt({
          role: 'planner',
          node,
          depOutputs: context.depOutputs,
          attempt: planningAttempt,
          effort,
        });
        planningToolCalls = [];
        const planningAttemptStart = new Date().toISOString();
        planningResult = undefined;
        const noProgressTimeoutMs = Math.max(
          1,
          planningNoToolProgressTimeoutMs ?? PLANNING_NO_TOOL_PROGRESS_TIMEOUT_MS,
        );
        const noProgressCheckIntervalMs = Math.max(
          1,
          planningNoToolProgressCheckIntervalMs ?? PLANNING_NO_TOOL_PROGRESS_CHECK_INTERVAL_MS,
        );

        const planningAttemptController = new AbortController();
        const planningNoProgressAbortController = () => {
          if (!planningAttemptController.signal.aborted) {
            planningAttemptController.abort(createPlanningNoProgressAbortError());
          }
        };
        const abortPlanningAttemptOnParentCancel = () => {
          planningAttemptController.abort(context.signal?.reason);
        };
        context.signal?.addEventListener('abort', abortPlanningAttemptOnParentCancel, { once: true });

        let planningNoProgressTriggered = false;
        const planningAttemptStartedAtMs = Date.now();
        let planningLastToolProgressAt = planningAttemptStartedAtMs;
        let sawPlanningToolCall = false;
        let planningPreFirstToolTokenUsage = 0;
                let planningPreFirstToolTokenNudged = false;
        let planningPreFirstToolTokenHardWarningEmitted = false;
                let planningNoToolInitialWarningEmitted = false;
        let planningNoToolProgressWarningEmitted = false;
        let planningNoToolAbortReason = '';
        let planningToolCallBudgetExceeded = false;
        let successfulPlanningToolCalls = 0;



        const planningNoProgressInterval = setInterval(() => {
          if (planningAttemptController.signal.aborted) {
            return;
          }

          if (!sawPlanningToolCall && Date.now() - planningAttemptStartedAtMs >= PLANNING_NO_TOOL_INITIAL_CUTOFF_MS) {
            const message =
              `Planning made no initial tool call for ${Math.ceil(PLANNING_NO_TOOL_INITIAL_CUTOFF_MS / 1000)}s. ${PLANNING_FIRST_TOOL_RETRY_DIRECTIVE}`;
            if (resolvedPlanningNoToolGuardMode === 'enforce') {
              planningNoProgressTriggered = true;
              planningNoToolAbortReason = message;
              planningNoProgressAbortController();
              return;
            }

            if (!planningNoToolInitialWarningEmitted) {
              planningNoToolInitialWarningEmitted = true;
              emit({
                type: 'task:verification-failed',
                taskId: node.id,
                attempt: planningAttempt,
                error: `Planning guard warning (warn-only mode): ${message}`,
              });
            }
          }

          if (Date.now() - planningLastToolProgressAt >= noProgressTimeoutMs) {
            const message = `Planning made no tool progress for ${Math.ceil(noProgressTimeoutMs / 1000)}s. ${PLANNING_NO_TOOL_PROGRESS_NUDGE}`;
            if (resolvedPlanningNoToolGuardMode === 'enforce') {
              planningNoProgressTriggered = true;
              planningNoToolAbortReason = message;
              planningNoProgressAbortController();
            } else if (!planningNoToolProgressWarningEmitted) {
              planningNoToolProgressWarningEmitted = true;
              planningLastToolProgressAt = Date.now();
              emit({
                type: 'task:verification-failed',
                taskId: node.id,
                attempt: planningAttempt,
                error: `Planning guard warning (warn-only mode): ${message}`,
              });
            }
          }
        }, noProgressCheckIntervalMs);

        try {
          planningResult = await executeRole({
            role: 'planner',
            agent: planningAgent,
            taskId: node.id,
            prompt: planningPrompt,
            provider: planningModel.provider,
            model: planningModel.model,
            systemPrompt: resolvedPlanningSystemPrompt,
            attempt: planningAttempt,
            signal: planningAttemptController.signal,
            emit,
            onUsage: (streamUsage: { input: number; output: number; cost: number }) => {
              if (sawPlanningToolCall) {
                return;
              }
              planningPreFirstToolTokenUsage = streamUsage.input + streamUsage.output;
              if (
                !planningPreFirstToolTokenNudged
                && planningPreFirstToolTokenUsage >= PLANNING_PRE_FIRST_TOOL_TOKEN_NUDGE_BUDGET
              ) {
                planningPreFirstToolTokenNudged = true;
                emit({
                  type: 'task:verification-failed',
                  taskId: node.id,
                  attempt: planningAttempt,
                  error: `Planning consumed ${planningPreFirstToolTokenUsage} tokens before first tool call. ${PLANNING_FIRST_TOOL_RETRY_DIRECTIVE}`,
                });
              }

              if (planningPreFirstToolTokenUsage >= PLANNING_PRE_FIRST_TOOL_TOKEN_ABORT_BUDGET) {
                const message =
                  `Planning consumed ${planningPreFirstToolTokenUsage} tokens before first tool call. ${PLANNING_FIRST_TOOL_RETRY_DIRECTIVE}`;
                if (resolvedPlanningNoToolGuardMode === 'enforce') {
                  planningNoProgressTriggered = true;
                  planningNoToolAbortReason = message;
                  planningNoProgressAbortController();
                } else if (!planningPreFirstToolTokenHardWarningEmitted) {
                  planningPreFirstToolTokenHardWarningEmitted = true;
                  emit({
                    type: 'task:verification-failed',
                    taskId: node.id,
                    attempt: planningAttempt,
                    error: `Planning guard warning (warn-only mode): ${message}`,
                  });
                }
              }
            },
                        onToolCall: (_event, replayRecord) => {
              planningLastToolProgressAt = Date.now();
              sawPlanningToolCall = true;
              planningNoToolInitialWarningEmitted = false;
              planningNoToolProgressWarningEmitted = false;
              planningToolCalls.push(replayRecord);

              if (isSuccessfulToolResultRecord(replayRecord)) {
                successfulPlanningToolCalls += 1;
                                if (successfulPlanningToolCalls > resolvedMaxPlanningToolCallsPerAttempt) {
                  planningNoProgressTriggered = true;
                  planningToolCallBudgetExceeded = true;
                  planningNoToolAbortReason =
                    `Planning tool-call budget exceeded (${successfulPlanningToolCalls}/${resolvedMaxPlanningToolCallsPerAttempt} successful tool calls). `
                    + 'Emit a concrete plan with explicit TODO items once key files and contract shape are identified; defer edge-case discovery to implementation.';
                  planningNoProgressAbortController();
                }

              }
            },

          });
        } catch (error) {
                    const wasPlanningNoProgressAbort = planningNoProgressTriggered || isPlanningNoProgressAbortError(error);
          const failureType = planningToolCallBudgetExceeded
            ? 'validation'
            : wasPlanningNoProgressAbort
              ? 'timeout'
              : resolveReplayFailureType(error);

          const planningError = wasPlanningNoProgressAbort
            ? planningNoToolAbortReason
              || `Planning made no tool progress for ${Math.ceil(noProgressTimeoutMs / 1000)}s. ${PLANNING_NO_TOOL_PROGRESS_NUDGE}`
            : error instanceof Error ? error.message : String(error);

          if (wasPlanningNoProgressAbort && planningToolCalls.length === 0) {
            consecutiveNoToolStagnationAttempts += 1;
          } else {
            consecutiveNoToolStagnationAttempts = 0;
          }
          if (planningToolCalls.length > 0) {
            consecutivePlanningContractStagnationAttempts = 0;
            previousPlanningContractSignature = undefined;
          }

          const shouldAbortForNoToolStagnation =
            resolvedPlanningNoToolGuardMode === 'enforce'
            && consecutiveNoToolStagnationAttempts >= PLANNING_NO_TOOL_STAGNATION_ABORT_ATTEMPTS;
          const noToolStagnationError = shouldAbortForNoToolStagnation
            ? `Planning stagnated across attempts with no tool calls (${consecutiveNoToolStagnationAttempts} consecutive attempts). Aborting to prevent infinite planning loop. Last failure: ${planningError}`
            : undefined;
          const effectivePlanningError = noToolStagnationError ?? planningError;
          const effectiveFailureType = noToolStagnationError ? 'validation' : failureType;

          const failedPlanningAttempt: ReplayAttemptRecord = {
            phase: 'planning',
            attempt: planningAttempt,
            startedAt: planningAttemptStart,
            completedAt: new Date().toISOString(),
            provider: planningModel.provider,
            model: planningModel.model,
            reasoning: planningModel.reasoning,
            error: effectivePlanningError,
            failureType: effectiveFailureType,
            toolCalls: planningToolCalls,
          };
          replay.attempts.push(failedPlanningAttempt);
          emit({
            type: 'task:replay-attempt',
            taskId: node.id,
            phase: 'planning',
            attempt: planningAttempt,
            record: failedPlanningAttempt,
          });

          if (
            !noToolStagnationError
            && planningAttempt < MAX_PLANNING_ATTEMPTS
            && shouldRetryAfterCompletionFailure(effectiveFailureType)
          ) {
            const delayMs = PLANNING_RETRY_BASE_DELAY_MS * (2 ** (planningAttempt - 1));
            emit({
              type: 'task:verification-failed',
              taskId: node.id,
              attempt: planningAttempt,
              error: `Planning attempt ${planningAttempt} failed (${effectiveFailureType}), retrying in ${delayMs}ms: ${effectivePlanningError}`,
            });
            await delay(delayMs);
            continue;
          }

          return {
            taskId: node.id,
            status: 'failed',
            tokenDumpDir: taskTokenDumpDir,
            error: effectivePlanningError,
            failureType: effectiveFailureType,
            durationMs: Date.now() - start,
            retries: planningAttempt - 1,
            usage,
            replay,
          };
        } finally {
          clearInterval(planningNoProgressInterval);
          context.signal?.removeEventListener('abort', abortPlanningAttemptOnParentCancel);
        }

        if (!planningResult) {
          return {
            taskId: node.id,
            status: 'failed',
            tokenDumpDir: taskTokenDumpDir,
            error: 'Planning attempt completed without a result.',
            failureType: 'unknown',
            durationMs: Date.now() - start,
            retries: planningAttempt - 1,
            usage,
            replay,
          };
        }
        const completedPlanningResult = planningResult;

        const completedPlanningAttempt: ReplayAttemptRecord = {
          phase: 'planning',
          attempt: planningAttempt,
          startedAt: planningAttemptStart,
          completedAt: new Date().toISOString(),
          provider: planningModel.provider,
          model: planningModel.model,
          reasoning: planningModel.reasoning,
          stopReason: completedPlanningResult.metadata?.stopReason,
          endpoint: completedPlanningResult.metadata?.endpoint,
          usage: completedPlanningResult.usage,
          textPreview: createTextPreview(completedPlanningResult.text),
          toolCalls: planningToolCalls,
        };
        replay.attempts.push(completedPlanningAttempt);
        emit({
          type: 'task:replay-attempt',
          taskId: node.id,
          phase: 'planning',
          attempt: planningAttempt,
          record: completedPlanningAttempt,
        });

        mergeUsage(usage, completedPlanningResult.usage);
        await appendTokenDump(planningTokenDumpPath, {
          graphId: graph.id,
          taskId: node.id,
          agent: 'planning',
          attempt: planningAttempt,
          provider: planningModel.provider,
          model: planningModel.model,
          usage: completedPlanningResult.usage,
        });

        if (createToolset) {
          const planningContractError = buildPlanningContractError(planningToolCalls, {
            task: node,
            quickStartMode,
            quickStartMaxPreDelegationToolCalls,
            taskEffort: effort,
          });
          if (planningContractError) {
            completedPlanningAttempt.failureType = 'validation';
            completedPlanningAttempt.error = planningContractError;

            const planningContractSignature = createPlanningContractFailureSignature(planningContractError);
            if (planningContractSignature === previousPlanningContractSignature) {
              consecutivePlanningContractStagnationAttempts += 1;
            } else {
              previousPlanningContractSignature = planningContractSignature;
              consecutivePlanningContractStagnationAttempts = 1;
            }

            const contractStagnationError =
              consecutivePlanningContractStagnationAttempts >= PLANNING_CONTRACT_STAGNATION_ABORT_ATTEMPTS
                ? `${PLANNING_CONTRACT_STAGNATION_ERROR_PREFIX} Repeated planning contract failure signature "${planningContractSignature}" for ${consecutivePlanningContractStagnationAttempts} consecutive attempts. Last error: ${planningContractError}`
                : undefined;

            if (!contractStagnationError && planningAttempt < MAX_PLANNING_ATTEMPTS) {
              const delayMs = PLANNING_RETRY_BASE_DELAY_MS * (2 ** (planningAttempt - 1));
              emit({
                type: 'task:verification-failed',
                taskId: node.id,
                attempt: planningAttempt,
                error: `Planning contract failed (attempt ${planningAttempt}), retrying in ${delayMs}ms: ${planningContractError}`,
              });
              await delay(delayMs);
              continue;
            }

            const finalPlanningContractError = contractStagnationError ?? planningContractError;
            emit({
              type: 'task:verification-failed',
              taskId: node.id,
              attempt: planningAttempt,
              error: finalPlanningContractError,
            });
            return {
              taskId: node.id,
              status: 'failed',
              tokenDumpDir: taskTokenDumpDir,
              error: finalPlanningContractError,
              failureType: 'validation',
              durationMs: Date.now() - start,
              retries: planningAttempt - 1,
              usage,
              replay,
            };
          }

          consecutiveNoToolStagnationAttempts = 0;
          consecutivePlanningContractStagnationAttempts = 0;
          previousPlanningContractSignature = undefined;
        }

        // Planning succeeded — break out of retry loop
        break;
      }

      if (!planningResult) {
        return {
          taskId: node.id,
          status: 'failed',
          tokenDumpDir: taskTokenDumpDir,
          error: 'Planning failed after all retry attempts.',
          failureType: 'unknown',
          durationMs: Date.now() - start,
          retries: MAX_PLANNING_ATTEMPTS,
          usage,
          replay,
        };
      }
      const resolvedPlanningResult = planningResult;
      const normalizedPlanningText = ensurePlanIncludesTestingSteps(
        resolvedPlanningResult.text,
        node.validation?.commands,
        {
          taskType: node.type,
        },
      );
      planningResult = {
        ...resolvedPlanningResult,
        text: normalizedPlanningText,
      };
      const finalizedPlanningResult = planningResult;

      persistedPlanPath = await persistPlan({
        baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
        graphId: graph.id,
        node,
        plan: finalizedPlanningResult.text,
      });
      emit({ type: 'task:plan-persisted', taskId: node.id, path: persistedPlanPath });

      const needsApproval = requirePlanApproval ?? true;
      if (needsApproval) {
        emit({ type: 'task:approval-requested', taskId: node.id, path: persistedPlanPath });
        if (!onPlanApproval) {
          return {
            taskId: node.id,
            status: 'failed',
            plan: finalizedPlanningResult.text,
            planPath: persistedPlanPath,
            tokenDumpDir: taskTokenDumpDir,
            error: 'Plan approval is required but no approval handler was provided.',
            durationMs: Date.now() - start,
            retries: 0,
            usage,
            replay,
          };
        }

        const approved = await onPlanApproval({
          task: node,
          plan: finalizedPlanningResult.text,
          planPath: persistedPlanPath,
        });

        if (!approved) {
          return {
            taskId: node.id,
            status: 'failed',
            plan: finalizedPlanningResult.text,
            planPath: persistedPlanPath,
            tokenDumpDir: taskTokenDumpDir,
            error: 'Plan was rejected by user approval gate.',
            durationMs: Date.now() - start,
            retries: 0,
            usage,
            replay,
          };
        }

        emit({ type: 'task:approved', taskId: node.id });
      }
    } else {
      planningResult = {
        text: ensurePlanIncludesTestingSteps(
          [
            effort === 'low'
              ? `Low-effort task routed to direct implementation (effort: ${effort}, reason: ${effortClassification.reason}).`
              : 'Trivial task gate routed this task to direct implementation.',
            `Classification reasons: ${trivialClassification.reasons.join(', ')}`,
          ].join('\n'),
          node.validation?.commands,
          {
            taskType: node.type,
          },
        ),
      };

      persistedPlanPath = await persistPlan({
        baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
        graphId: graph.id,
        node,
        plan: planningResult.text,
      });
      emit({ type: 'task:plan-persisted', taskId: node.id, path: persistedPlanPath });
    }

    const implAgent = await spawnRoleAgent({
      llm,
      role: 'implementer',
      task: node,
      graphId: graph.id,
      cwd,
      model: implementationModel,
      systemPrompt: resolvedImplementationSystemPrompt,
      signal: context.signal,
      createToolset,
      resolveApiKey,
      taskRequiresWrites,
    });

    const taskRetryBudget = Math.max(0, node.validation?.maxRetries ?? 0);
    const maxAttempts = Math.max(
      1,
      maxImplementationAttempts ?? taskRetryBudget + 1,
    );

    const taskTesterConfig = node.tester;
    const resolvedTesterEnabled = taskTesterConfig?.enabled ?? testerConfig?.enabled ?? false;
    const resolvedTesterRequireRunTests = taskTesterConfig?.requireRunTests ?? testerConfig?.requireRunTests ?? true;
    const resolvedTesterEnforceUiTestsForUiChanges =
      taskTesterConfig?.enforceUiTestsForUiChanges
      ?? testerConfig?.enforceUiTestsForUiChanges
      ?? true;
    const resolvedTesterRequireUiScreenshotsForUiChanges =
      taskTesterConfig?.requireUiScreenshotsForUiChanges
      ?? testerConfig?.requireUiScreenshotsForUiChanges
      ?? true;
    const resolvedTesterMinUiScreenshotCount =
      sanitizeMinUiScreenshotCount(
        taskTesterConfig?.minUiScreenshotCount
        ?? testerConfig?.minUiScreenshotCount,
      );
    const resolvedTesterUiChangePatterns =
      taskTesterConfig?.uiChangePatterns
      ?? testerConfig?.uiChangePatterns
      ?? [];
    const resolvedTesterUiTestCommandPatterns =
      taskTesterConfig?.uiTestCommandPatterns
      ?? testerConfig?.uiTestCommandPatterns
      ?? [];
    const resolvedTesterModel = taskTesterConfig?.model ?? testerConfig?.model ?? defaultTesterModel ?? implementationModel;
    const resolvedTesterSystemPrompt = testerConfig?.systemPrompt;
    const resolvedTesterExecutionSystemPrompt =
      resolvedTesterSystemPrompt
      ?? buildRoleSystemPrompt({
        role: 'tester',
        task: node,
        graphId: graph.id,
        cwd,
        provider: resolvedTesterModel.provider,
        model: resolvedTesterModel.model,
        reasoning: resolvedTesterModel.reasoning,
      });

    return executeImplementerRole({
      task: node,
      graphId: graph.id,
      depOutputs: context.depOutputs,
      approvedPlan: planningResult?.text,
      planPath: persistedPlanPath,
      effort,
      implementationModel,
      implementationSystemPrompt: resolvedImplementationSystemPrompt,
      implAgent,
      signal: context.signal,
      cwd,
      emit,
      startTimeMs: start,
      taskTokenDumpDir,
      implementationTokenDumpPath,
      usage,
      replay,
      maxAttempts,
      appendTokenDump,
      postValidationGate: async ({ attempt, output, signal }) => {
        const changedFiles = Array.isArray(output.filesChanged)
          ? output.filesChanged
            .filter((path): path is string => typeof path === 'string')
            .map((path) => path.trim())
            .filter((path) => path.length > 0)
          : [];
        const hasCodeChanges = changedFiles.length > 0;
        const uiChangesDetected = detectUiChanges(changedFiles, resolvedTesterUiChangePatterns);

        const reconciledPlanText = ensurePlanIncludesTestingSteps(
          planningResult?.text ?? '',
          node.validation?.commands,
          {
            taskType: node.type,
            changedFiles,
            uiChangesDetected,
          },
        );

        if (planningResult?.text !== reconciledPlanText) {
          planningResult = {
            ...(planningResult ?? {}),
            text: reconciledPlanText,
          };
          if (persistedPlanPath) {
            persistedPlanPath = await persistPlan({
              baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
              graphId: graph.id,
              node,
              plan: reconciledPlanText,
            });
          }
        }

        const plannerTestPlan = extractPlannerTestingSteps(planningResult?.text);
        const requiredTestPlanBuckets = deriveRequiredTestPlanBuckets({
          taskType: node.type,
          changedFiles,
          uiChangesDetected,
        });
        const missingBuckets = findMissingPlannerTestPlanBuckets(plannerTestPlan, requiredTestPlanBuckets);

        if (hasCodeChanges && !persistedPlanPath) {
          return {
            approved: false,
            error:
              'Implementation changed files but no persisted plan was available. A persisted plan is mandatory when code changes occur.',
          };
        }

        if (hasCodeChanges && plannerTestPlan.length === 0) {
          return {
            approved: false,
            error:
              'Implementation changed files but the persisted plan does not include a concrete test plan. Add explicit testing steps before completion.',
          };
        }

        if (hasCodeChanges && missingBuckets.length > 0) {
          return {
            approved: false,
            error:
              `Planner test plan is missing required coverage derived from prompt and changed files: ${missingBuckets.join(', ')}.`,
          };
        }

        if (!resolvedTesterEnabled || !hasCodeChanges) {
          return { approved: true, output };
        }

        const uiTestsRequired = uiChangesDetected && resolvedTesterEnforceUiTestsForUiChanges;
        const screenshotsRequired = uiTestsRequired && resolvedTesterRequireUiScreenshotsForUiChanges;

        emit({
          type: 'task:testing',
          taskId: node.id,
          attempt,
          plannerTestPlan,
          changedFiles,
          uiChangesDetected,
          uiTestsRequired,
          screenshotsRequired,
        });

        const testerAgent = await spawnRoleAgent({
          llm,
          role: 'tester',
          task: node,
          graphId: graph.id,
          cwd,
          model: resolvedTesterModel,
          systemPrompt: resolvedTesterExecutionSystemPrompt,
          signal,
          createToolset,
          resolveApiKey,
          taskRequiresWrites,
        });

        const testerResult = await executeTesterRole({
          task: node,
          approvedPlan: planningResult?.text,
          implementationOutput: {
            ...output,
            filesChanged: changedFiles,
          },
          testerAgent,
          testerModel: resolvedTesterModel,
          testerSystemPrompt: resolvedTesterExecutionSystemPrompt,
          attempt,
          signal,
          emit,
          requireRunTests: resolvedTesterRequireRunTests,
          requireUiTests: uiTestsRequired,
          requireUiScreenshots: screenshotsRequired,
          minUiScreenshotCount: resolvedTesterMinUiScreenshotCount,
          uiChangesDetected,
          uiTestCommandPatterns: resolvedTesterUiTestCommandPatterns,
          workspacePath: cwd,
        });

        mergeUsage(usage, testerResult.usage);
        await appendTokenDump(testerTokenDumpPath, {
          graphId: graph.id,
          taskId: node.id,
          agent: 'testing',
          attempt,
          provider: resolvedTesterModel.provider,
          model: resolvedTesterModel.model,
          usage: testerResult.usage,
        });

        const testerVerdict = testerResult.verdict;
        if (!testerVerdict) {
          return {
            approved: false,
            error:
              'Tester gate did not return a verdict for a code-changing task while tester mode is enabled.',
          };
        }

        emit({
          type: 'task:tester-verdict',
          taskId: node.id,
          attempt,
          approved: testerVerdict.approved,
          testsPassed: testerVerdict.testsPassed,
          testsFailed: testerVerdict.testsFailed,
          rejectionReason: testerVerdict.rejectionReason,
          testPlan: testerVerdict.testPlan,
          coverageAssessment: testerVerdict.coverageAssessment,
          qualityAssessment: testerVerdict.qualityAssessment,
          testedAreas: testerVerdict.testedAreas,
          executedTestCommands: testerVerdict.executedTestCommands,
          uiChangesDetected: testerVerdict.uiChangesDetected,
          uiTestsRequired: testerVerdict.uiTestsRequired,
          uiTestsRun: testerVerdict.uiTestsRun,
          screenshotPaths: testerVerdict.screenshotPaths,
        });

        if (testerVerdict.approved) {
          const outputWithTesterVerdict = {
            ...output,
            testerVerdict,
          };
          if (!outputWithTesterVerdict.testerVerdict) {
            return {
              approved: false,
              error:
                'Tester gate approved but no tester verdict was attached to the implementation output.',
            };
          }

          return {
            approved: true,
            output: outputWithTesterVerdict,
          };
        }

        return {
          approved: false,
          error: formatTesterGateFailureMessage(testerVerdict),
        };
      },
    });
  };

  return runDag(managedRetryGraph, executor, {
    ...config,
    onEvent: emit,
  });
}

async function appendTokenDump(
  path: string,
  entry: {
    graphId: string;
    taskId: string;
    agent: 'planning' | 'implementation' | 'testing';
    attempt: number;
    provider: string;
    model: string;
    usage?: { input: number; output: number; cost: number };
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    time: new Date().toISOString(),
    graphId: entry.graphId,
    taskId: entry.taskId,
    agent: entry.agent,
    attempt: entry.attempt,
    provider: entry.provider,
    model: entry.model,
    tokens: {
      input: entry.usage?.input ?? 0,
      output: entry.usage?.output ?? 0,
      cost: entry.usage?.cost ?? 0,
    },
  };

  await appendFile(path, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function sanitizeForPath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function persistPlan(params: {
  baseDir: string;
  graphId: string;
  node: TaskNode;
  plan: string;
}): Promise<string> {
  const graphDir = join(params.baseDir, sanitizeForPath(params.graphId));
  await mkdir(graphDir, { recursive: true });

  const filename = `${sanitizeForPath(params.node.id)}.md`;
  const fullPath = join(graphDir, filename);

  const content = [
    `# Task Plan: ${params.node.name}`,
    '',
    `- Task ID: ${params.node.id}`,
    `- Task Type: ${params.node.type}`,
    `- Generated At: ${new Date().toISOString()}`,
    '',
    '## Task Prompt',
    '',
    params.node.prompt,
    '',
    '## Deep Plan',
    '',
    params.plan,
    '',
  ].join('\n');

  await writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

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

function sanitizeMaxPlanningToolCallsPerAttempt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_PLANNING_TOOL_CALLS_PER_ATTEMPT;
  }

  return Math.max(1, Math.floor(value));
}

function isSuccessfulToolResultRecord(record: ReplayToolCallRecord): boolean {
  return record.status === 'result' && !record.isError;
}

function resolveTaskRequiresWrites(task: TaskNode): boolean {

  const routeCategory = readTaskMetaString(task, 'routeCategory');
  const routeStrategy = readTaskMetaString(task, 'routeStrategy');
  if (routeCategory === 'investigation' || routeStrategy === 'read_only_analysis') {
    return false;
  }

  return true;
}

const DEFAULT_UI_CHANGE_PATTERNS = [
  'packages/ui/**',
  '**/*.tsx',
  '**/*.jsx',
  '**/*.css',
  '**/*.scss',
  '**/*.html',
];

const PLANNER_TEST_PLAN_KEYWORD_REGEX =
  /\b(test|testing|verify|validation|unit|integration|playwright|e2e|screenshot)\b/i;
const UNIT_TEST_STEP_REGEX = /\bunit\b/i;
const INTEGRATION_TEST_STEP_REGEX = /\bintegration\b/i;
const UI_E2E_TEST_STEP_REGEX = /\b(playwright|e2e|ui\s+test)\b/i;
const API_TEST_STEP_REGEX = /\b(api|contract|schema|endpoint|route)\b/i;
const INFRA_TEST_STEP_REGEX = /\b(terraform|infra|infrastructure|helm|k8s|deployment|rollback|plan)\b/i;

type PlanCoverageBucket = 'unit' | 'integration' | 'ui-e2e' | 'api-contract' | 'infra-validation';

interface PlanContextHints {
  taskType: TaskNode['type'];
  changedFiles?: string[];
  uiChangesDetected?: boolean;
}

function deriveRequiredTestPlanBuckets(context: PlanContextHints): PlanCoverageBucket[] {
  const hasCodeChanges = Array.isArray(context.changedFiles) && context.changedFiles.length > 0;
  const isCodeTask = context.taskType === 'code';
  const changedFiles = Array.isArray(context.changedFiles) ? context.changedFiles : [];
  const normalizedChangedFiles = changedFiles.map((path) => normalizePathForMatching(path).toLowerCase());
  const requiresUiCoverage =
    context.uiChangesDetected
    || normalizedChangedFiles.some((path) =>
      path.startsWith('packages/ui/')
      || path.endsWith('.tsx')
      || path.endsWith('.jsx')
      || path.endsWith('.css')
      || path.endsWith('.scss')
      || path.endsWith('.html'),
    );

  const requiresApiContractCoverage = normalizedChangedFiles.some((path) =>
    path.includes('/api/')
    || path.includes('/routes/')
    || path.includes('/controller')
    || path.includes('/server/')
    || path.includes('/handler')
    || path.includes('/endpoint'),
  );

  const requiresInfraValidation = normalizedChangedFiles.some((path) =>
    path.startsWith('infra/')
    || path.includes('/terraform/')
    || path.includes('/k8s/')
    || path.includes('/helm/')
    || path.endsWith('dockerfile')
    || path.includes('/.github/workflows/'),
  );

  const required = new Set<PlanCoverageBucket>();
  if (isCodeTask || hasCodeChanges) {
    required.add('unit');
    required.add('integration');
  }

  if (requiresUiCoverage) {
    required.add('ui-e2e');
  }

  if (requiresApiContractCoverage) {
    required.add('api-contract');
  }

  if (requiresInfraValidation) {
    required.add('infra-validation');
  }

  return [...required];
}

function findMissingPlannerTestPlanBuckets(
  plannerTestPlan: string[],
  requiredBuckets: PlanCoverageBucket[],
): PlanCoverageBucket[] {
  const normalizedItems = plannerTestPlan.map((line) => line.toLowerCase());
  const hasUnit = normalizedItems.some((line) => UNIT_TEST_STEP_REGEX.test(line));
  const hasIntegration = normalizedItems.some((line) => INTEGRATION_TEST_STEP_REGEX.test(line));
  const hasUiE2E = normalizedItems.some((line) => UI_E2E_TEST_STEP_REGEX.test(line));
  const hasApiContract = normalizedItems.some((line) => API_TEST_STEP_REGEX.test(line));
  const hasInfraValidation = normalizedItems.some((line) => INFRA_TEST_STEP_REGEX.test(line));

  return requiredBuckets.filter((bucket) => {
    if (bucket === 'unit') {
      return !hasUnit;
    }
    if (bucket === 'integration') {
      return !hasIntegration;
    }
    if (bucket === 'ui-e2e') {
      return !hasUiE2E;
    }
    if (bucket === 'api-contract') {
      return !hasApiContract;
    }
    return !hasInfraValidation;
  });
}

function ensurePlanIncludesTestingSteps(
  planText: string,
  validationCommands: string[] | undefined,
  context: PlanContextHints,
): string {
  const normalizedPlanText = planText.trim();
  const existingTestingSteps = extractPlannerTestingSteps(normalizedPlanText);
  const requiredBuckets = deriveRequiredTestPlanBuckets(context);
  const missingBuckets = findMissingPlannerTestPlanBuckets(existingTestingSteps, requiredBuckets);

  if (existingTestingSteps.length > 0 && missingBuckets.length === 0) {
    return normalizedPlanText;
  }

  const commandSteps = Array.isArray(validationCommands)
    ? validationCommands
      .filter((command): command is string => typeof command === 'string')
      .map((command) => command.trim())
      .filter((command) => command.length > 0)
      .slice(0, 4)
      .map((command) => `- VERIFY-ONLY: Run validation command ${command}.`)
    : [];

  const synthesizedSteps = [
    ...existingTestingSteps.map((step) => `- ${step}`),
    ...commandSteps,
  ];

  if (requiredBuckets.includes('unit')) {
    synthesizedSteps.push('- ADD-CODEBASE: Add or update unit tests covering changed behavior.');
  }

  if (requiredBuckets.includes('integration')) {
    synthesizedSteps.push('- ADD-CODEBASE: Add or update integration tests for affected workflows.');
  }

  if (requiredBuckets.includes('ui-e2e')) {
    synthesizedSteps.push('- ADD-CODEBASE: Add or update Playwright e2e tests for the UI flow.');
    synthesizedSteps.push('- VERIFY-ONLY: Capture Playwright screenshot evidence for the changed UI behavior.');
  }

  if (requiredBuckets.includes('api-contract')) {
    synthesizedSteps.push('- ADD-CODEBASE: Add or update API contract and endpoint integration tests for changed server behavior.');
  }

  if (requiredBuckets.includes('infra-validation')) {
    synthesizedSteps.push('- VERIFY-ONLY: Run infrastructure validation and plan checks (terraform/helm/deployment dry-run) and capture rollback evidence.');
  }

  if (synthesizedSteps.length === 0) {
    synthesizedSteps.push('- VERIFY-ONLY: Run lint/typecheck/build validations for touched packages.');
  }

  const dedupedSteps: string[] = [];
  const seen = new Set<string>();
  for (const step of synthesizedSteps) {
    const normalized = step.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    dedupedSteps.push(step);
  }

  return [
    normalizedPlanText,
    '',
    '## Test Plan',
    '',
    ...dedupedSteps,
  ].join('\n');
}

function extractPlannerTestingSteps(planText: string | undefined): string[] {
  if (!planText || planText.trim().length === 0) {
    return [];
  }

  const lines = planText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) => line.length > 0);

  const extracted: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!PLANNER_TEST_PLAN_KEYWORD_REGEX.test(line)) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    extracted.push(line);

    if (extracted.length >= 16) {
      break;
    }
  }

  return extracted;
}

function detectUiChanges(filesChanged: string[] | undefined, configuredPatterns: string[]): boolean {
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
    return false;
  }

  const normalizedFiles = filesChanged
    .map((path) => normalizePathForMatching(path))
    .filter((path) => path.length > 0);

  if (normalizedFiles.length === 0) {
    return false;
  }

  const patterns = configuredPatterns.length > 0 ? configuredPatterns : DEFAULT_UI_CHANGE_PATTERNS;
  const compiledPatterns = patterns
    .map((pattern) => compileGlobPattern(pattern))
    .filter((matcher): matcher is RegExp => matcher !== null);

  if (compiledPatterns.length === 0) {
    return normalizedFiles.some((path) => path.startsWith('packages/ui/'));
  }

  return normalizedFiles.some((path) => compiledPatterns.some((matcher) => matcher.test(path)));
}

function normalizePathForMatching(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return normalized;
}

function compileGlobPattern(pattern: string): RegExp | null {
  const normalized = normalizePathForMatching(pattern);
  if (normalized.length === 0) {
    return null;
  }

  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${escaped}$`, 'i');
}

function sanitizeMinUiScreenshotCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 2;
  }

  return Math.max(1, Math.floor(value));
}

function formatTesterGateFailureMessage(verdict: {
  testPlan: string[];
  testedAreas: string[];
  executedTestCommands: string[];
  testsPassed: number;
  testsFailed: number;
  coverageAssessment?: string;
  qualityAssessment?: string;
  uiChangesDetected: boolean;
  uiTestsRequired: boolean;
  uiTestsRun: boolean;
  screenshotPaths: string[];
  rejectionReason?: string;
  suggestedFixes?: string[];
  testOutput?: string;
}): string {
  const lines = [
    `Tester gate rejected implementation (passed=${verdict.testsPassed}, failed=${verdict.testsFailed}).`,
  ];

  if (verdict.rejectionReason) {
    lines.push(`Reason: ${verdict.rejectionReason}`);
  }

  if (verdict.coverageAssessment) {
    lines.push(`Coverage: ${verdict.coverageAssessment}`);
  }

  if (verdict.qualityAssessment) {
    lines.push(`Quality: ${verdict.qualityAssessment}`);
  }

  if (verdict.testPlan.length > 0) {
    lines.push('Test plan:');
    for (const item of verdict.testPlan) {
      lines.push(`- ${item}`);
    }
  }

  if (verdict.testedAreas.length > 0) {
    lines.push(`Tested areas: ${verdict.testedAreas.join(', ')}`);
  }

  if (verdict.executedTestCommands.length > 0) {
    lines.push('Executed test commands:');
    for (const command of verdict.executedTestCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    `UI evidence: changesDetected=${verdict.uiChangesDetected} required=${verdict.uiTestsRequired} ran=${verdict.uiTestsRun} screenshots=${verdict.screenshotPaths.length}`,
  );

  if (verdict.screenshotPaths.length > 0) {
    lines.push('Screenshot paths:');
    for (const screenshotPath of verdict.screenshotPaths) {
      lines.push(`- ${screenshotPath}`);
    }
  }

  if (verdict.suggestedFixes && verdict.suggestedFixes.length > 0) {
    lines.push('Suggested fixes:');
    for (const fix of verdict.suggestedFixes) {
      lines.push(`- ${fix}`);
    }
  }

  if (verdict.testOutput) {
    lines.push('Test output:');
    lines.push(verdict.testOutput);
  }

  return lines.join('\n');
}

function readTaskMetaString(task: TaskNode, key: string): string | undefined {
  const value = task.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function createTextPreview(text: string, maxChars = 600): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }

  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function resolvePromptVersion(params: {
  explicitVersion?: string;
  systemPrompt?: string;
  planningSystemPrompt?: string;
  implementationSystemPrompt?: string;
}): string {
  if (params.explicitVersion && params.explicitVersion.trim().length > 0) {
    return params.explicitVersion.trim();
  }

  const customPromptSource = [
    params.systemPrompt,
    params.planningSystemPrompt,
    params.implementationSystemPrompt,
  ]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join('\n\n---\n\n');

  if (!customPromptSource) {
    return DEFAULT_ORCHESTRATOR_PROMPT_VERSION;
  }

  const fingerprint = createHash('sha256').update(customPromptSource).digest('hex').slice(0, 12);
  return `custom-system-prompts-${fingerprint}`;
}
