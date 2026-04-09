import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  TaskGraph,
  TaskNode,
  TaskOutput,
  RunnerConfig,
  ModelConfig,
  ReplayFailureType,
  ReplayAttemptRecord,
  ReplayToolCallRecord,
  TaskReplayRecord,
} from '../dag/types.js';
import type { TaskExecutionContext } from '../dag/scheduler.js';
import { runDag } from '../dag/scheduler.js';
import { validate } from '../validation/validator.js';
import type { LlmAdapter, LlmToolset } from '@orchestrace/provider';
import { classifyTrivialTaskNode, classifyTaskEffort, resolveTrivialTaskGateConfig } from './task-complexity.js';
import type { TaskEffort } from './task-complexity.js';
import {
  PLANNING_FIRST_TOOL_RETRY_DIRECTIVE,
  buildImplementationPrompt,
  buildPlanningPrompt,
  buildRoleSystemPrompt,
} from './role-config.js';
import { executeRole, spawnRoleAgent } from './role-executor.js';

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
  /** Optional factory for phase-specific agent tools. */
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
  /** Override task effort classification. When set, controls execution strategy:
   *  trivial/low = skip planning; medium = sub-agents optional; high = full orchestration. */
  taskEffort?: TaskEffort;
}

type PlanningNoToolGuardMode = 'enforce' | 'warn';

const DEFAULT_ORCHESTRATOR_PROMPT_VERSION = 'orchestrator-prompts-v2';
const MAX_PLANNING_ATTEMPTS = 3;
const PLANNING_RETRY_BASE_DELAY_MS = 2_000;
const PLANNING_NO_TOOL_PROGRESS_TIMEOUT_MS = 5 * 60_000;
const PLANNING_NO_TOOL_PROGRESS_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_PLANNING_NO_TOOL_GUARD_MODE: PlanningNoToolGuardMode = 'enforce';
const PLANNING_NO_TOOL_PROGRESS_NUDGE =
  'Planning did not make tool progress. Use a concrete tool call to advance the plan.';
const PLANNING_NO_PROGRESS_ABORT_SENTINEL = '__orchestrace_planning_no_progress__';
const PLANNING_NO_TOOL_INITIAL_CUTOFF_MS = 20_000;
const PLANNING_PRE_FIRST_TOOL_TOKEN_NUDGE_BUDGET = 2_000;
const PLANNING_PRE_FIRST_TOOL_TOKEN_ABORT_BUDGET = 3_000;
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
    taskEffort: configTaskEffort,
  } = config;

  const emit = onEvent ?? (() => {});
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

    const trivialTaskGate = resolveTrivialTaskGateConfig({
      enabled: enableTrivialTaskGate,
      maxPromptLength: trivialTaskMaxPromptLength,
    });
    const trivialClassification = classifyTrivialTaskNode(node, trivialTaskGate);
    const taskRequiresWrites = resolveTaskRequiresWrites(node);

    // Resolve effective effort: explicit config > prompt classification
    const effortClassification = classifyTaskEffort(node.prompt);
    const effort: TaskEffort = configTaskEffort ?? effortClassification.effort;
    // Skip planning for trivial/low effort tasks
    const shouldSkipPlanning = trivialClassification.isTrivial || effort === 'trivial' || effort === 'low';

    let planningResult:
      | { text: string; usage?: { input: number; output: number; cost: number }; metadata?: { stopReason?: string; endpoint?: string } }
      | undefined;
    let persistedPlanPath: string | undefined;
    const resolvedPlanningNoToolGuardMode = normalizePlanningNoToolGuardMode(planningNoToolGuardMode);

    if (!shouldSkipPlanning) {
      const planningAgent = await spawnRoleAgent({
        llm,
        role: 'planner',
        task: node,
        graphId: graph.id,
        cwd,
        model: planningModel,
        systemPrompt:
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
          }),
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
        const planningPrompt = buildPlanningPrompt(node, context.depOutputs, planningAttempt, effort);
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
            },
          });
        } catch (error) {
          const wasPlanningNoProgressAbort = planningNoProgressTriggered || isPlanningNoProgressAbortError(error);
          const failureType = wasPlanningNoProgressAbort ? 'timeout' : resolveReplayFailureType(error);
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

      persistedPlanPath = await persistPlan({
        baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
        graphId: graph.id,
        node,
        plan: resolvedPlanningResult.text,
      });
      emit({ type: 'task:plan-persisted', taskId: node.id, path: persistedPlanPath });

      const needsApproval = requirePlanApproval ?? true;
      if (needsApproval) {
        emit({ type: 'task:approval-requested', taskId: node.id, path: persistedPlanPath });
        if (!onPlanApproval) {
          return {
            taskId: node.id,
            status: 'failed',
            plan: resolvedPlanningResult.text,
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
          plan: resolvedPlanningResult.text,
          planPath: persistedPlanPath,
        });

        if (!approved) {
          return {
            taskId: node.id,
            status: 'failed',
            plan: resolvedPlanningResult.text,
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
        text: [
          effort === 'low'
            ? `Low-effort task routed to direct implementation (effort: ${effort}, reason: ${effortClassification.reason}).`
            : 'Trivial task gate routed this task to direct implementation.',
          `Classification reasons: ${trivialClassification.reasons.join(', ')}`,
        ].join('\n'),
      };
    }

    const implAgent = await spawnRoleAgent({
      llm,
      role: 'implementer',
      task: node,
      graphId: graph.id,
      cwd,
      model: implementationModel,
      systemPrompt:
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
        }),
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

    let lastResponse = '';
    let lastFailureType: ReplayFailureType | undefined;
    let lastValidationError = '';
    let lastValidationResults = undefined as TaskOutput['validationResults'];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      emit({
        type: 'task:implementation-attempt',
        taskId: node.id,
        attempt,
        maxAttempts,
      });

      const implementationPrompt = buildImplementationPrompt({
        node,
        depOutputs: context.depOutputs,
        approvedPlan: planningResult?.text,
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
          taskId: node.id,
          prompt: implementationPrompt,
          attempt,
          signal: context.signal,
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
          taskId: node.id,
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
            taskId: node.id,
            attempt,
            error: `Retrying after ${failureType} failure: ${implementationError}`,
          });
          await delay(PLANNING_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
          continue;
        }

        return {
          taskId: node.id,
          status: 'failed',
          plan: planningResult.text,
          planPath: persistedPlanPath,
          tokenDumpDir: taskTokenDumpDir,
          response: lastResponse,
          error: implementationError,
          failureType,
          durationMs: Date.now() - start,
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
        taskId: node.id,
        phase: 'implementation',
        attempt,
        record: completedImplementationAttempt,
      });

      mergeUsage(usage, implResult.usage);
      await appendTokenDump(implementationTokenDumpPath, {
        graphId: graph.id,
        taskId: node.id,
        agent: 'implementation',
        attempt,
        provider: implementationModel.provider,
        model: implementationModel.model,
        usage: implResult.usage,
      });
      lastResponse = implResult.text;

      const output: TaskOutput = {
        taskId: node.id,
        status: 'completed',
        plan: planningResult?.text,
        planPath: persistedPlanPath,
        tokenDumpDir: taskTokenDumpDir,
        response: implResult.text,
        filesChanged: implResult.filesChanged,
        durationMs: Date.now() - start,
        retries: attempt - 1,
        usage,
        replay,
      };

      if (!node.validation) {
        return output;
      }

      emit({ type: 'task:validating', taskId: node.id });
      const validationResults = await validate(output, node.validation, cwd);
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
        taskId: node.id,
        attempt,
        error: lastValidationError,
      });
    }

    return {
      taskId: node.id,
      status: 'failed',
      plan: planningResult?.text,
      planPath: persistedPlanPath,
      tokenDumpDir: taskTokenDumpDir,
      response: lastResponse,
      validationResults: lastValidationResults,
      error: lastValidationError || 'Implementation did not satisfy validation criteria.',
      failureType: lastFailureType ?? 'validation',
      durationMs: Date.now() - start,
      retries: maxAttempts - 1,
      usage,
      replay,
    };
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
    agent: 'planning' | 'implementation';
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

function resolveTaskRequiresWrites(task: TaskNode): boolean {
  const routeCategory = readTaskMetaString(task, 'routeCategory');
  const routeStrategy = readTaskMetaString(task, 'routeStrategy');
  if (routeCategory === 'investigation' || routeStrategy === 'read_only_analysis') {
    return false;
  }

  return true;
}

function readTaskMetaString(task: TaskNode, key: string): string | undefined {
  const value = task.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function createPlanningNoProgressAbortError(): Error {
  const error = new Error(PLANNING_NO_PROGRESS_ABORT_SENTINEL);
  (error as Error & { failureType?: ReplayFailureType }).failureType = 'empty_response';
  return error;
}

function createPlanningContractFailureSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/attempt\s+\d+/g, 'attempt')
    .trim();
}

function normalizePlanningNoToolGuardMode(value: unknown): PlanningNoToolGuardMode {
  return value === 'warn' ? 'warn' : DEFAULT_PLANNING_NO_TOOL_GUARD_MODE;
}

function isPlanningNoProgressAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === PLANNING_NO_PROGRESS_ABORT_SENTINEL;
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

function buildPlanningContractError(
  toolCalls: ReplayToolCallRecord[],
  options?: {
    task?: TaskNode;
    quickStartMode?: boolean;
    quickStartMaxPreDelegationToolCalls?: number;
    taskEffort?: TaskEffort;
  },
): string | undefined {
  const effort = options?.taskEffort ?? 'high';

  // Low/trivial effort skips planning entirely, so never reaches this.
  // Medium/high: require todo_set + agent_graph_set as structural scaffolding.
  const requiredTools = ['todo_set', 'agent_graph_set'];
  const missing = requiredTools.filter((toolName) => !hasSuccessfulToolCall(toolCalls, toolName));

  const contractIssues: string[] = [];
  if (missing.length > 0) {
    contractIssues.push(`Missing successful coordination tool call(s): ${missing.join(', ')}.`);
  }

  // Validate format of todo_set if it was called
  const todoSetResult = latestSuccessfulToolCall(toolCalls, 'todo_set');
  if (todoSetResult) {
    const todoValidation = validateWeightedListPayload(
      resolveToolCallInputForValidation(toolCalls, 'todo_set', todoSetResult),
      'items',
    );
    if (todoValidation.sum === undefined) {
      contractIssues.push('todo_set must include numeric weight for each item.');
    } else if (!isWeightTotalValid(todoValidation.sum)) {
      contractIssues.push(`todo_set item weights must sum to 100 (received ${formatWeightTotal(todoValidation.sum)}).`);
    }

    for (const issue of todoValidation.issues) {
      contractIssues.push(`todo_set ${issue}`);
    }
  }

  // Validate format of agent_graph_set if it was called
  const graphSetResult = latestSuccessfulToolCall(toolCalls, 'agent_graph_set');
  if (graphSetResult) {
    const graphValidation = validateWeightedListPayload(
      resolveToolCallInputForValidation(toolCalls, 'agent_graph_set', graphSetResult),
      'nodes',
    );
    if (graphValidation.sum === undefined) {
      contractIssues.push('agent_graph_set must include numeric weight for each node.');
    } else if (!isWeightTotalValid(graphValidation.sum)) {
      contractIssues.push(`agent_graph_set node weights must sum to 100 (received ${formatWeightTotal(graphValidation.sum)}).`);
    }

    for (const issue of graphValidation.issues) {
      contractIssues.push(`agent_graph_set ${issue}`);
    }
  }

  // Validate that sub-agent nodeIds map to graph nodes when both are used
  const hasSubAgentDelegation = hasSuccessfulToolCall(toolCalls, 'subagent_spawn')
    || hasSuccessfulToolCall(toolCalls, 'subagent_spawn_batch');
  const graphNodeIds = graphSetResult
    ? validateWeightedListPayload(
        resolveToolCallInputForValidation(toolCalls, 'agent_graph_set', graphSetResult),
        'nodes',
      ).ids
    : new Set<string>();
  if (graphNodeIds.size > 0 && hasSubAgentDelegation) {
    const delegatedNodeIds = collectSubAgentNodeIds(toolCalls);
    const mappedNodes = [...graphNodeIds].filter((nodeId) => delegatedNodeIds.has(nodeId));
    if (mappedNodes.length === 0) {
      contractIssues.push('subagent delegation must include nodeId values that map to agent_graph_set node ids.');
    }
  }

  if (contractIssues.length === 0) {
    return undefined;
  }

  return [
    'Planning contract not satisfied.',
    ...contractIssues,
    `Task effort: ${effort}. Planning must publish todo_set + agent_graph_set before implementation can begin. Sub-agent delegation is your choice — use it when it helps, skip it when the task is simple.`,
  ].join(' ');
}

function isFocusedTaskForZeroPlanningSubagents(task: TaskNode): boolean {
  const prompt = task.prompt ?? '';
  const affectedFiles = extractPromptFilePaths(prompt);
  if (affectedFiles.length === 0 || affectedFiles.length >= 3) {
    return false;
  }

  const hasKnownModuleReference = affectedFiles.some((filePath) => /(^|\/)(packages\/|src\/|apps\/|services\/)/i.test(filePath))
    || /\b(ui-server\.ts|runner\.ts|orchestrator\.ts)\b/i.test(prompt);
  if (!hasKnownModuleReference) {
    return false;
  }

  return /\b(behavior|change|fix|enforce|update|adjust|modify|regression|policy|logic)\b/i.test(prompt);
}

function extractPromptFilePaths(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const paths = new Set<string>();
  let inRelevantFilesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed) && !/^#{1,6}\s+relevant files\b/i.test(trimmed)) {
      inRelevantFilesSection = false;
    }

    if (/^(?:#{1,6}\s+)?relevant files\b:?/i.test(trimmed)) {
      inRelevantFilesSection = true;
      continue;
    }

    if (inRelevantFilesSection) {
      const bulletMatch = trimmed.match(/^(?:[-*•]|\d+\.)\s+`?([A-Za-z0-9._\/-]+\.[A-Za-z0-9_-]+)`?/);
      if (bulletMatch?.[1]) {
        paths.add(normalizePromptPath(bulletMatch[1]));
      }
    }
  }

  const inlinePathRegex = /(?:^|[\s`"'])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9_-]+)(?=$|[\s`"',):;])/g;
  for (const match of prompt.matchAll(inlinePathRegex)) {
    const path = match[1]?.trim();
    if (path) {
      paths.add(normalizePromptPath(path));
    }
  }

  return [...paths];
}

function normalizePromptPath(filePath: string): string {
  return filePath.replace(/^\.\//, '').trim();
}

function hasSuccessfulToolCall(toolCalls: ReplayToolCallRecord[], toolName: string): boolean {
  return toolCalls.some((call) => call.status === 'result' && call.toolName === toolName && !call.isError);
}

function normalizeQuickStartMaxPreDelegationToolCalls(value: number | undefined): number {
  if (Number.isFinite(value) && typeof value === 'number' && value >= 0) {
    return Math.floor(value);
  }

  return 3;
}

function assessQuickStartDelegation(
  toolCalls: ReplayToolCallRecord[],
  maxPreDelegationToolCalls: number,
): {
  hasDelegation: boolean;
  withinLimit: boolean;
  preDelegationSuccessfulToolCalls: number;
} {
  let successfulToolCallCount = 0;

  for (const call of toolCalls) {
    if (call.status !== 'result' || call.isError) {
      continue;
    }

    const isDelegationCall = call.toolName === 'subagent_spawn' || call.toolName === 'subagent_spawn_batch';
    if (isDelegationCall) {
      return {
        hasDelegation: true,
        withinLimit: successfulToolCallCount <= maxPreDelegationToolCalls,
        preDelegationSuccessfulToolCalls: successfulToolCallCount,
      };
    }

    successfulToolCallCount += 1;
  }

  return {
    hasDelegation: false,
    withinLimit: false,
    preDelegationSuccessfulToolCalls: successfulToolCallCount,
  };
}

function latestSuccessfulToolCall(
  toolCalls: ReplayToolCallRecord[],
  toolName: string,
): ReplayToolCallRecord | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.status === 'result' && call.toolName === toolName && !call.isError) {
      return call;
    }
  }

  return undefined;
}

function resolveToolCallInputForValidation(
  toolCalls: ReplayToolCallRecord[],
  toolName: string,
  successfulResultCall: ReplayToolCallRecord,
): string | undefined {
  if (successfulResultCall.input) {
    return successfulResultCall.input;
  }

  if (successfulResultCall.toolCallId) {
    for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
      const call = toolCalls[index];
      if (call.toolCallId !== successfulResultCall.toolCallId) {
        continue;
      }
      if (call.toolName !== toolName || call.status !== 'started') {
        continue;
      }
      if (call.input) {
        return call.input;
      }
    }
  }

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.toolName === toolName && call.status === 'started' && call.input) {
      return call.input;
    }
  }

  return undefined;
}

function validateWeightedListPayload(
  input: string | undefined,
  listKey: 'items' | 'nodes',
): {
  sum: number | undefined;
  issues: string[];
  ids: Set<string>;
} {
  const issues: string[] = [];
  const ids = new Set<string>();
  const dependenciesById = new Map<string, string[]>();
  let sum = 0;

  if (!input) {
    return { sum: undefined, issues, ids };
  }

  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const entries = Array.isArray(parsed[listKey]) ? parsed[listKey] : undefined;
    if (!entries || entries.length === 0) {
      issues.push('must include at least one entry.');
      return { sum: undefined, issues, ids };
    }

    for (let index = 0; index < entries.length; index += 1) {
      const rawEntry = entries[index];
      const prefix = `entry #${index + 1}`;
      if (!rawEntry || typeof rawEntry !== 'object') {
        issues.push(`${prefix} must be an object.`);
        continue;
      }

      const entry = rawEntry as Record<string, unknown>;
      const rawId = entry.id;
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id) {
        issues.push(`${prefix} must include a non-empty id.`);
      } else if (ids.has(id)) {
        issues.push(`${prefix} uses duplicate id "${id}".`);
      } else {
        ids.add(id);
      }

      const weight = entry.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        issues.push(`${prefix} must include a positive numeric weight.`);
      } else {
        sum += weight;
      }

      if (listKey === 'items') {
        const status = typeof entry.status === 'string' ? entry.status.trim() : '';
        if (status !== 'todo' && status !== 'in_progress' && status !== 'done') {
          issues.push(`${prefix} has invalid status "${status || '<missing>'}"; expected todo, in_progress, or done.`);
        }
      }

      const dependencyKey = listKey === 'items' ? 'dependsOn' : 'dependencies';
      const rawDeps = entry[dependencyKey];
      const deps = Array.isArray(rawDeps)
        ? rawDeps
          .map((value) => typeof value === 'string' ? value.trim() : '')
          .filter((value) => value.length > 0)
        : [];
      if (id) {
        dependenciesById.set(id, deps);
      }
    }

    for (const [id, deps] of dependenciesById.entries()) {
      for (const dep of deps) {
        if (dep === id) {
          issues.push(`entry "${id}" cannot depend on itself.`);
          continue;
        }
        if (!ids.has(dep)) {
          issues.push(`entry "${id}" references unknown dependency "${dep}".`);
        }
      }
    }

    if (hasDependencyCycle(dependenciesById)) {
      issues.push('contains a dependency cycle.');
    }

    return { sum, issues, ids };
  } catch {
    return {
      sum: undefined,
      ids,
      issues: ['payload is not valid JSON.'],
    };
  }
}

function hasDependencyCycle(dependenciesById: Map<string, string[]>): boolean {
  const stateById = new Map<string, 'visiting' | 'visited'>();

  const visit = (nodeId: string): boolean => {
    const current = stateById.get(nodeId);
    if (current === 'visiting') {
      return true;
    }
    if (current === 'visited') {
      return false;
    }

    stateById.set(nodeId, 'visiting');
    const deps = dependenciesById.get(nodeId) ?? [];
    for (const dep of deps) {
      if (!dependenciesById.has(dep)) {
        continue;
      }
      if (visit(dep)) {
        return true;
      }
    }
    stateById.set(nodeId, 'visited');
    return false;
  };

  for (const nodeId of dependenciesById.keys()) {
    if (visit(nodeId)) {
      return true;
    }
  }

  return false;
}

function collectSubAgentNodeIds(toolCalls: ReplayToolCallRecord[]): Set<string> {
  const nodeIds = new Set<string>();

  for (const call of toolCalls) {
    // Accept both 'started' and 'result' events since result events may lack input
    if (call.isError) {
      continue;
    }

    if (call.toolName === 'subagent_spawn') {
      const parsed = parseToolCallInput(call.input);
      const nodeId = parsed && typeof parsed.nodeId === 'string' ? parsed.nodeId.trim() : '';
      if (nodeId) {
        nodeIds.add(nodeId);
      }
      continue;
    }

    if (call.toolName === 'subagent_spawn_batch') {
      const parsed = parseToolCallInput(call.input);
      const agents = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
      for (const rawAgent of agents) {
        if (!rawAgent || typeof rawAgent !== 'object') {
          continue;
        }
        const agent = rawAgent as Record<string, unknown>;
        const nodeId = typeof agent.nodeId === 'string' ? agent.nodeId.trim() : '';
        if (nodeId) {
          nodeIds.add(nodeId);
        }
      }
    }
  }

  return nodeIds;
}

function parseToolCallInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isWeightTotalValid(value: number): boolean {
  return Math.abs(value - 100) <= 0.5;
}

function formatWeightTotal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
