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
import type { LlmAdapter, LlmToolset } from '@orchestrace/provider';
import { classifyTrivialTaskNode, classifyTaskEffort, resolveTrivialTaskGateConfig } from './task-complexity.js';
import type { TaskEffort } from './task-complexity.js';
import {
  PLANNING_FIRST_TOOL_RETRY_DIRECTIVE,
  buildRoleTaskPrompt,
  buildRoleSystemPrompt,
} from './role-config.js';
import { executeImplementerRole, executeRole, spawnRoleAgent } from './role-executor.js';
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

const DEFAULT_ORCHESTRATOR_PROMPT_VERSION = 'orchestrator-prompts-v2';
const MAX_PLANNING_ATTEMPTS = 3;
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

    return executeImplementerRole({
      task: node,
      graphId: graph.id,
      depOutputs: context.depOutputs,
      approvedPlan: planningResult?.text,
      planPath: persistedPlanPath,
      effort,
      implementationModel,
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
