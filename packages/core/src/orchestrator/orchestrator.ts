import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
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
import { PromptSectionName, renderPromptSections, type PromptSection } from '../prompt/sections.js';
import type {
  LlmAdapter,
  LlmToolCall,
  LlmToolCallEvent,
  LlmToolResult,
  LlmToolset,
} from '@orchestrace/provider';

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
  /** Directory for persisted plans. Defaults to <cwd>/.orchestrace/plans. */
  planOutputDir?: string;
  /** Require user approval before implementation. Defaults to true. */
  requirePlanApproval?: boolean;
  /** Callback used to approve/reject persisted plans. */
  onPlanApproval?: (request: PlanApprovalRequest) => Promise<boolean>;
  /** Optional provider auth resolver (env, OAuth store, secret manager, etc.). */
  resolveApiKey?: (provider: string) => Promise<string | undefined>;
  /** Optional resolver for workspace git SHA used in cache keying. */
  resolveWorkspaceGitSha?: (cwd: string) => Promise<string | undefined>;
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
  }) => LlmToolset | undefined;
  /** Max implementation attempts per task. Defaults to validation.maxRetries + 1. */
  maxImplementationAttempts?: number;
  /** Directory for per-agent token dumps. Defaults to <cwd>/.orchestrace/tokens. */
  tokenDumpDir?: string;
  /** Replay prompt version tag persisted into task outputs. */
  promptVersion?: string;
  /** Replay policy version tag persisted into task outputs. */
  policyVersion?: string;
  /** Max wall-clock budget for planning phase across retries. Default 120000ms. */
  planningPhaseBudgetMs?: number;
  /** Optional hard timeout for each individual planning attempt. Defaults to remaining phase budget. */
  planningAttemptTimeoutMs?: number;
  /** Ratio threshold for planning token budget warnings. Default 0.3 (30%). */
  planningTokenBudgetWarningRatio?: number;
  /** Optional total token budget used for warning thresholds. */
  totalTokenBudget?: number;
  /** Proceed with best-effort fallback plan when planning timeout budget is exceeded. Default true. */
  forceProceedOnPlanningTimeout?: boolean;
  /** Require approval before implementation when timeout fallback plan is used. Default false. */
  requireApprovalOnPlanningTimeoutFallback?: boolean;
  /** Maximum consecutive non-progress events before opening planning circuit breaker. */
  maxNoProgressEvents?: number;
}

type OrchestratorPhase = 'planning' | 'implementation';
type PlanningMode = 'fast' | 'full';

const DEFAULT_ORCHESTRATOR_PROMPT_VERSION = 'orchestrator-prompts-v2';
const DEFAULT_PLANNING_PHASE_BUDGET_MS = 120_000;
const DEFAULT_MAX_NO_PROGRESS_EVENTS = 4_000;
const MAX_PLANNING_ATTEMPTS = 3;
const PLANNING_RETRY_BASE_DELAY_MS = 2_000;
const RETRY_CONTEXT_MAX_CHARS = 2_000;

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
    planningSystemPrompt,
    implementationSystemPrompt,
    planOutputDir,
    tokenDumpDir,
    requirePlanApproval,
    onPlanApproval,
    resolveApiKey,
    resolveWorkspaceGitSha,
    planningPhaseBudgetMs,
    planningAttemptTimeoutMs,
    forceProceedOnPlanningTimeout,
    requireApprovalOnPlanningTimeoutFallback,
    maxNoProgressEvents,
    createToolset,
    maxImplementationAttempts,
    onEvent,
    promptVersion,
    policyVersion,
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

    const model: ModelConfig = node.model ?? context.defaultModel ?? {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };
    const apiKey = await resolveApiKey?.(model.provider);
    const refreshApiKey = resolveApiKey
      ? async () => resolveApiKey(model.provider)
      : undefined;

    const usage = { input: 0, output: 0, cost: 0 };
    const replay: TaskReplayRecord = {
      version: 1,
      graphId: graph.id,
      taskId: node.id,
      promptVersion: resolvedPromptVersion,
      policyVersion: policyVersion ?? 'default-v1',
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      attempts: [],
    };
    const taskTokenDumpDir = join(
      tokenDumpDir ?? join(cwd, '.orchestrace', 'tokens'),
      sanitizeForPath(graph.id),
      sanitizeForPath(node.id),
    );
    const planningTokenDumpPath = join(taskTokenDumpDir, 'planning.jsonl');
    const implementationTokenDumpPath = join(taskTokenDumpDir, 'implementation.jsonl');
    const workspaceGitSha = await resolveWorkspaceGitShaSafe(cwd, resolveWorkspaceGitSha);
    const subAgentResultCache = new Map<string, LlmToolResult>();

    const planningToolset = wrapToolsetWithSubAgentCache({
      toolset: createToolset?.({
        phase: 'planning',
        task: node,
        graphId: graph.id,
        cwd,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
      }),
      workspaceGitSha,
      cache: subAgentResultCache,
    });

    const implementationToolset = wrapToolsetWithSubAgentCache({
      toolset: createToolset?.({
        phase: 'implementation',
        task: node,
        graphId: graph.id,
        cwd,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
      }),
      workspaceGitSha,
      cache: subAgentResultCache,
    });

    const planningAgent = await llm.spawnAgent({
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      systemPrompt:
        planningSystemPrompt
        ?? systemPrompt
        ?? buildPhaseSystemPrompt({
          phase: 'planning',
          task: node,
          graphId: graph.id,
          cwd,
          provider: model.provider,
          model: model.model,
          reasoning: model.reasoning,
        }),
      signal: context.signal,
      toolset: planningToolset,
      apiKey,
      refreshApiKey,
    });

    emit({ type: 'task:planning', taskId: node.id });

    const planningMode = determinePlanningMode(node);
    const planningPrompt = buildPlanningPrompt(node, context.depOutputs, planningMode);
    const planningPhaseStartMs = Date.now();
    const planningBudgetMs = Math.max(1, planningPhaseBudgetMs ?? DEFAULT_PLANNING_PHASE_BUDGET_MS);
    const planningAttemptBudgetMs = Math.max(1, planningAttemptTimeoutMs ?? planningBudgetMs);
    const shouldForceProceedOnTimeout = forceProceedOnPlanningTimeout ?? true;
    const noProgressLimit = Math.max(1, maxNoProgressEvents ?? DEFAULT_MAX_NO_PROGRESS_EVENTS);

    let planningResult;
    let planningToolCalls: ReplayToolCallRecord[] = [];
    let planningBudgetExceeded = false;
    let planningCircuitBreakerReason: string | undefined;
    const planningProgress = createNoProgressTracker(noProgressLimit);

    for (let planningAttempt = 1; planningAttempt <= MAX_PLANNING_ATTEMPTS; planningAttempt++) {
      const planningElapsedMs = Date.now() - planningPhaseStartMs;
      const remainingPlanningBudgetMs = planningBudgetMs - planningElapsedMs;
      if (remainingPlanningBudgetMs <= 0) {
        planningBudgetExceeded = true;
        break;
      }

      planningToolCalls = [];
      const planningAttemptStart = new Date().toISOString();
      planningResult = undefined;
      planningProgress.reset();
      const activeAttemptBudgetMs = Math.max(1, Math.min(planningAttemptBudgetMs, remainingPlanningBudgetMs));

      try {
        planningResult = await withTimeout(planningAgent.complete(planningPrompt, context.signal, {
          onTextDelta: (delta) => {
            if (planningProgress.onNonProgressEvent() && !planningCircuitBreakerReason) {
              planningCircuitBreakerReason = `Planning circuit breaker opened after ${planningProgress.getCount()} consecutive non-progress events (threshold ${noProgressLimit}).`;
            }

            emit({
              type: 'task:stream-delta',
              taskId: node.id,
              phase: 'planning',
              attempt: planningAttempt,
              delta,
            });
          },
          onToolCall: (event) => {
            planningToolCalls.push(toReplayToolCallRecord(event));
            if (planningProgress.onToolCall(event) && !planningCircuitBreakerReason) {
              planningCircuitBreakerReason = `Planning circuit breaker opened after ${planningProgress.getCount()} consecutive non-progress events (threshold ${noProgressLimit}).`;
            }

            emit({
              type: 'task:tool-call',
              taskId: node.id,
              phase: 'planning',
              attempt: planningAttempt,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.type,
              input: event.arguments,
              output: event.result,
              isError: event.isError,
            });
          },
        }), activeAttemptBudgetMs, `Planning attempt ${planningAttempt} exceeded ${activeAttemptBudgetMs}ms timeout budget.`);
      } catch (error) {
        const planningError = error instanceof Error ? error.message : String(error);
        if (planningError.includes('timeout budget')) {
          planningBudgetExceeded = true;
          break;
        }

        const failureType = resolveReplayFailureType(error);
        const failedPlanningAttempt: ReplayAttemptRecord = {
          phase: 'planning',
          attempt: planningAttempt,
          startedAt: planningAttemptStart,
          completedAt: new Date().toISOString(),
          provider: model.provider,
          model: model.model,
          reasoning: model.reasoning,
          error: planningError,
          failureType,
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

        if (planningAttempt < MAX_PLANNING_ATTEMPTS && shouldRetryAfterCompletionFailure(failureType)) {
          const delayMs = PLANNING_RETRY_BASE_DELAY_MS * (2 ** (planningAttempt - 1));
          emit({
            type: 'task:verification-failed',
            taskId: node.id,
            attempt: planningAttempt,
            error: `Planning attempt ${planningAttempt} failed (${failureType}), retrying in ${delayMs}ms: ${planningError}`,
          });
          await delay(delayMs);
          continue;
        }

        return {
          taskId: node.id,
          status: 'failed',
          tokenDumpDir: taskTokenDumpDir,
          error: planningError,
          failureType,
          durationMs: Date.now() - start,
          retries: planningAttempt - 1,
          usage,
          replay,
        };
      }

      if (planningCircuitBreakerReason) {
        const failureType: ReplayFailureType = 'budget_exhausted';
        const failedPlanningAttempt: ReplayAttemptRecord = {
          phase: 'planning',
          attempt: planningAttempt,
          startedAt: planningAttemptStart,
          completedAt: new Date().toISOString(),
          provider: model.provider,
          model: model.model,
          reasoning: model.reasoning,
          error: planningCircuitBreakerReason,
          failureType,
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
        emit({
          type: 'task:warning',
          taskId: node.id,
          phase: 'planning',
          code: 'NO_PROGRESS_CIRCUIT_BREAKER',
          message: planningCircuitBreakerReason,
          details: {
            noProgressEvents: planningProgress.getCount(),
            maxNoProgressEvents: noProgressLimit,
          },
        });

        return {
          taskId: node.id,
          status: 'failed',
          tokenDumpDir: taskTokenDumpDir,
          error: planningCircuitBreakerReason,
          failureType,
          durationMs: Date.now() - start,
          retries: planningAttempt - 1,
          usage,
          replay,
        };
      }

      const completedPlanningAttempt: ReplayAttemptRecord = {
        phase: 'planning',
        attempt: planningAttempt,
        startedAt: planningAttemptStart,
        completedAt: new Date().toISOString(),
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
        stopReason: planningResult.metadata?.stopReason,
        endpoint: planningResult.metadata?.endpoint,
        usage: planningResult.usage,
        textPreview: createTextPreview(planningResult.text),
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

      mergeUsage(usage, planningResult.usage);
      await appendTokenDump(planningTokenDumpPath, {
        graphId: graph.id,
        taskId: node.id,
        agent: 'planning',
        attempt: planningAttempt,
        provider: model.provider,
        model: model.model,
        usage: planningResult.usage,
      });

      if (createToolset) {
        const planningContractError = buildPlanningContractError(planningToolCalls, planningMode);
        if (planningContractError) {
          completedPlanningAttempt.failureType = 'validation';
          completedPlanningAttempt.error = planningContractError;

          if (planningAttempt < MAX_PLANNING_ATTEMPTS) {
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

          emit({
            type: 'task:verification-failed',
            taskId: node.id,
            attempt: planningAttempt,
            error: planningContractError,
          });
          return {
            taskId: node.id,
            status: 'failed',
            tokenDumpDir: taskTokenDumpDir,
            error: planningContractError,
            failureType: 'validation',
            durationMs: Date.now() - start,
            retries: planningAttempt - 1,
            usage,
            replay,
          };
        }
      }

      // Planning succeeded — break out of retry loop
      break;
    }

    const approvedPlanText = planningResult?.text
      ?? (planningBudgetExceeded && shouldForceProceedOnTimeout
        ? buildPlanningTimeoutFallbackPlan(node)
        : undefined);

    if (!approvedPlanText) {
      return {
        taskId: node.id,
        status: 'failed',
        tokenDumpDir: taskTokenDumpDir,
        error: planningBudgetExceeded
          ? `Planning phase exceeded ${planningBudgetMs}ms budget and force-proceed is disabled.`
          : 'Planning failed after all retry attempts.',
        failureType: planningBudgetExceeded ? 'budget_exhausted' : 'unknown',
        durationMs: Date.now() - start,
        retries: MAX_PLANNING_ATTEMPTS,
        usage,
        replay,
      };
    }

    // approvedPlanText is guaranteed above via fallback/guard.

    if (planningBudgetExceeded) {
      emit({
        type: 'task:warning',
        taskId: node.id,
        phase: 'planning',
        code: 'PLANNING_TIMEOUT_FORCED_TRANSITION',
        message: `Planning budget exceeded after ${Date.now() - planningPhaseStartMs}ms; forcing transition to implementation.`,
        details: {
          planningPhaseBudgetMs: planningBudgetMs,
          forceProceedOnPlanningTimeout: shouldForceProceedOnTimeout,
        },
      });
    }

    const persistedPlanPath = await persistPlan({
      baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
      graphId: graph.id,
      node,
      plan: approvedPlanText,
    });
    emit({ type: 'task:plan-persisted', taskId: node.id, path: persistedPlanPath });

    const needsApproval = requirePlanApproval ?? true;
    if (needsApproval) {
      emit({ type: 'task:approval-requested', taskId: node.id, path: persistedPlanPath });
      if (!onPlanApproval) {
        return {
          taskId: node.id,
          status: 'failed',
          plan: approvedPlanText,
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
        plan: approvedPlanText,
        planPath: persistedPlanPath,
      });

      if (!approved) {
        return {
          taskId: node.id,
          status: 'failed',
          plan: approvedPlanText,
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

    const implAgent = await llm.spawnAgent({
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      systemPrompt:
        implementationSystemPrompt
        ?? systemPrompt
        ?? buildPhaseSystemPrompt({
          phase: 'implementation',
          task: node,
          graphId: graph.id,
          cwd,
          provider: model.provider,
          model: model.model,
          reasoning: model.reasoning,
        }),
      signal: context.signal,
      toolset: implementationToolset,
      apiKey,
      refreshApiKey,
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
    const implementationProgress = createNoProgressTracker(noProgressLimit);

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
        approvedPlan: approvedPlanText,
        attempt,
        previousResponse: lastResponse,
        previousFailureType: lastFailureType,
        previousValidationError: lastValidationError,
      });

      const implementationToolCalls: ReplayToolCallRecord[] = [];
      const implementationAttemptStart = new Date().toISOString();
      let implementationCircuitBreakerReason: string | undefined;
      implementationProgress.reset();
      let implResult;
      try {
        implResult = await implAgent.complete(implementationPrompt, context.signal, {
          onTextDelta: (delta) => {
            if (implementationProgress.onNonProgressEvent() && !implementationCircuitBreakerReason) {
              implementationCircuitBreakerReason = `Implementation circuit breaker opened after ${implementationProgress.getCount()} consecutive non-progress events (threshold ${noProgressLimit}).`;
            }

            emit({
              type: 'task:stream-delta',
              taskId: node.id,
              phase: 'implementation',
              attempt,
              delta,
            });
          },
          onToolCall: (event) => {
            implementationToolCalls.push(toReplayToolCallRecord(event));
            if (implementationProgress.onToolCall(event) && !implementationCircuitBreakerReason) {
              implementationCircuitBreakerReason = `Implementation circuit breaker opened after ${implementationProgress.getCount()} consecutive non-progress events (threshold ${noProgressLimit}).`;
            }

            emit({
              type: 'task:tool-call',
              taskId: node.id,
              phase: 'implementation',
              attempt,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.type,
              input: event.arguments,
              output: event.result,
              isError: event.isError,
            });
          },
        });

        if (implementationCircuitBreakerReason) {
          const failureType: ReplayFailureType = 'budget_exhausted';
          const failedImplementationAttempt: ReplayAttemptRecord = {
            phase: 'implementation',
            attempt,
            startedAt: implementationAttemptStart,
            completedAt: new Date().toISOString(),
            provider: model.provider,
            model: model.model,
            reasoning: model.reasoning,
            error: implementationCircuitBreakerReason,
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
          emit({
            type: 'task:warning',
            taskId: node.id,
            phase: 'implementation',
            code: 'NO_PROGRESS_CIRCUIT_BREAKER',
            message: implementationCircuitBreakerReason,
            details: {
              noProgressEvents: implementationProgress.getCount(),
              maxNoProgressEvents: noProgressLimit,
            },
          });

          return {
            taskId: node.id,
            status: 'failed',
            plan: approvedPlanText,
            planPath: persistedPlanPath,
            tokenDumpDir: taskTokenDumpDir,
            response: lastResponse,
            error: implementationCircuitBreakerReason,
            failureType,
            durationMs: Date.now() - start,
            retries: attempt - 1,
            usage,
            replay,
          };
        }
      } catch (error) {
        const failureType = resolveReplayFailureType(error);
        const implementationError = error instanceof Error ? error.message : String(error);
        const failedImplementationAttempt: ReplayAttemptRecord = {
          phase: 'implementation',
          attempt,
          startedAt: implementationAttemptStart,
          completedAt: new Date().toISOString(),
          provider: model.provider,
          model: model.model,
          reasoning: model.reasoning,
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
          plan: approvedPlanText,
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
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
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
        provider: model.provider,
        model: model.model,
        usage: implResult.usage,
      });
      lastResponse = implResult.text;

      const output: TaskOutput = {
        taskId: node.id,
        status: 'completed',
        plan: approvedPlanText,
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
      plan: approvedPlanText,
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

function buildPlanningPrompt(
  node: TaskNode,
  depOutputs: Map<string, TaskOutput>,
  planningMode: PlanningMode,
): string {
  const depContext = buildDependencyContext(depOutputs);
  return renderPromptSections([
    {
      name: PromptSectionName.Goal,
      lines: [
        planningMode === 'fast'
          ? 'Create a focused implementation plan for the following cleanup/removal task.'
          : 'Create a deep implementation plan for the following task.',
        planningMode === 'fast'
          ? 'Prioritize a streamlined, deterministic flow that reaches code edits quickly.'
          : 'Optimize for maximum safe concurrency and explicit multi-stage execution.',
        planningMode === 'fast'
          ? 'Use fast-path flow: (1) single grep/search pass, (2) derive edit plan from results, (3) execute scoped edits.'
          : 'Use full planning flow with research, synthesis, and coordinated delegation.',
        'Before each tool call and after each tool result, narrate your reasoning: what you learned, what you plan to do next, and why.',
      ],
    },
    {
      name: PromptSectionName.Autonomy,
      lines: [
        'If a tool call fails, use the error details to correct arguments and retry instead of aborting.',
        'Decompose planning work into atomic tasks: each todo should represent one action and one completion outcome.',
        'Never bundle multiple actions in one task; split broad work into smaller tasks before finalizing the plan.',
        'Each planned task must include a concrete target, explicit done criteria, and at least one verification command.',
        'If a task would take more than ~15 minutes or touches multiple independent areas, split it further.',
        'You MUST use coordination tools during planning:',
        '- todo_set (required) to create a concrete todo list',
        '- todo_set items must include numeric weight per item, and the total weight must sum to exactly 100',
        '- todo_set item ids must be unique, and dependsOn can only reference ids from the same todo_set payload',
        '- todo_set item status values must be exactly one of: todo, in_progress, done',
        '- todo_update to track progress changes',
        '- todo statuses must be exactly: todo, in_progress, done',
        '- agent_graph_set (required) to define sub-agent dependency graph',
        '- agent_graph_set nodes must include numeric weight per node, and the total node weight must sum to exactly 100',
        '- agent_graph_set node ids must be unique, and dependency ids can only reference nodes from the same payload',
        '- in agent_graph_set, provide descriptive node ids/names (avoid generic n1/n2 labels)',
        '- agent_graph_set nodes must map to atomic execution units with explicit dependency ids',
        planningMode === 'fast'
          ? '- subagent_spawn/subagent_spawn_batch are optional in fast-path mode when simple grep→plan→edit is sufficient'
          : '- subagent_spawn/subagent_spawn_batch (required) to delegate focused planning research with only relevant context per sub-agent',
        ...(planningMode === 'fast'
          ? []
          : [
              '- ALWAYS use subagent_spawn_batch (not individual subagent_spawn calls) when multiple independent sub-agents can run concurrently',
              '- subagent_spawn/subagent_spawn_batch calls must include nodeId values that map back to agent_graph_set node ids',
              '- pass nodeId on each sub-agent request so graph progress can be tracked per node',
            ]),
      ],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'Your plan must include:',
        '1) assumptions and constraints',
        '2) multi-stage execution waves (stage 1..N)',
        '3) per-stage atomic tasks with explicit dependencies and concurrency boundaries',
        '4) files likely to change',
        '5) verification strategy with explicit commands',
        '6) rollback/risk notes',
        planningMode === 'fast'
          ? '7) if sub-agents are used, include a delegation map aligned to agent_graph_set nodes and minimal per-agent context'
          : '7) a sub-agent delegation map aligned to agent_graph_set nodes and minimal per-agent context',
        '8) atomic todo specification per task: {id, action, target, deps, verification, done_criteria}',
        '9) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions',
      ],
    },
    {
      name: PromptSectionName.TaskContext,
      lines: [
        `Task ID: ${node.id}`,
        `Task Name: ${node.name}`,
        `Task Type: ${node.type}`,
        `Planning Mode: ${planningMode}`,
        '',
        'Task Prompt:',
        node.prompt,
      ],
    },
    {
      name: PromptSectionName.DependencyContext,
      lines: [depContext],
    },
  ]);
}

function buildImplementationPrompt(params: {
  node: TaskNode;
  depOutputs: Map<string, TaskOutput>;
  approvedPlan: string;
  attempt: number;
  previousResponse: string;
  previousFailureType?: ReplayFailureType;
  previousValidationError: string;
}): string {
  const {
    node,
    depOutputs,
    approvedPlan,
    attempt,
    previousResponse,
    previousFailureType,
    previousValidationError,
  } = params;

  const depContext = buildDependencyContext(depOutputs);
  const retryContext =
    attempt > 1
      ? [
          '',
          'Previous attempt failure type:',
          previousFailureType ?? '(unknown)',
          '',
          'Previous attempt response:',
          truncateForRetry(previousResponse) || '(no response)',
          '',
          'Validation failures to fix:',
          truncateForRetry(previousValidationError) || '(missing validation details)',
        ].join('\n')
      : '';

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Goal,
      lines: [
        'Execute the approved plan and implement the requested changes.',
        'You must satisfy validation criteria before considering the task complete.',
        'Before each tool call and after each tool result, narrate your reasoning: what you learned, what you plan to do next, and why.',
      ],
    },
    {
      name: PromptSectionName.Autonomy,
      lines: [
        'Operate in multi-stage waves and maximize safe concurrency.',
        'If a tool call fails, read the error details, adjust arguments, and retry the tool call.',
        'Before coding, read todo_get and follow the todo list strictly.',
        'Update todo states using todo_update as you progress.',
        'Read agent_graph_get and spawn dependent sub-agents with subagent_spawn throughout execution.',
        'ALWAYS use subagent_spawn_batch (not sequential subagent_spawn calls) when multiple independent nodes are ready to run in parallel.',
        'Delegate only task-relevant context to each sub-agent; avoid sending full unrelated history.',
        'Pass nodeId for each spawned sub-agent so the execution graph can reflect live progress.',
        'Keep sub-agent outputs concise and integrate them into the main implementation.',
        'Before finishing, ensure all todos are done and all agent graph nodes are completed (no failed nodes).',
        'After validation succeeds, create/switch a feature branch, commit all changes, push the branch, and open/update a PR using github_api (never gh CLI).',
        'After each push or PR update, probe remote CI/check status via github_api and continue until checks are green or a true blocker is reached.',
        'Do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api, then keep iterating until the PR is merge-ready or a true blocker is reached.',
        'If remote checks fail, inspect failing workflows/check-runs, fix root causes, rerun local validation, push again, and re-check CI.',
        'If git/PR automation fails, read the exact error, retry with corrected command/flags, and continue from the same point.',
      ],
    },
    {
      name: PromptSectionName.TaskContext,
      lines: [
        `Attempt: ${attempt}`,
        `Task ID: ${node.id}`,
        `Task Name: ${node.name}`,
        '',
        'Original task prompt:',
        node.prompt,
      ],
    },
    {
      name: PromptSectionName.ApprovedPlan,
      lines: [approvedPlan],
    },
    {
      name: PromptSectionName.DependencyContext,
      lines: [depContext],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'End your implementation response with "Next Follow-up Suggestions" and 1-3 numbered, concrete next actions.',
      ],
    },
  ];

  if (retryContext) {
    sections.push({
      name: PromptSectionName.RetryContext,
      lines: [retryContext],
    });
  }

  return renderPromptSections(sections);
}

function buildPhaseSystemPrompt(params: {
  phase: OrchestratorPhase;
  task: TaskNode;
  graphId: string;
  cwd: string;
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}): string {
  const { phase, task, graphId, cwd, provider, model, reasoning } = params;

  const phaseRules =
    phase === 'planning'
      ? [
          'Produce a concrete, execution-ready plan before implementation.',
          'Do not edit files in planning mode.',
          'Keep todo and dependency graph state synchronized as you reason.',
          'Planning output must be atomic: each planned task should be one action, one artifact, and one verification path.',
          'Before finalizing, split any multi-action task into separate todo and graph nodes.',
          'Each todo and graph node must include explicit dependency ids and deterministic done criteria.',
          'todo_set must define weighted planning breakdown where item weights sum to 100.',
          'todo_set ids must be unique and dependsOn references must resolve to known todo_set ids.',
          'todo_set status values must be exactly todo, in_progress, or done.',
          'agent_graph_set must define weighted implementation breakdown where node weights sum to 100.',
          'agent_graph_set ids must be unique and dependency ids must resolve within the same payload.',
          'subagent delegation must include nodeId values that map to agent_graph_set node ids.',
          'Planning must include successful todo_set and agent_graph_set tool calls.',
          'Planning must include successful subagent_spawn or subagent_spawn_batch calls with focused context per sub-agent.',
          'Prefer smallest safe units for parallelism; independent atomic tasks should be separated into parallelizable nodes.',
          'Planning responses must end with 1-3 concrete next follow-up suggestions.',
          'Return a plan that another agent could execute deterministically.',
        ]
      : [
          'Execute the approved plan and deliver validated code changes.',
          'Read relevant files before editing and keep edits minimal in scope.',
          'Use todo and agent graph state as the execution backbone, updating progress continuously.',
          'Use subagent_spawn or subagent_spawn_batch for parallelizable slices and delegate only relevant context to each sub-agent.',
          'Do not stop until todo list is done and agent graph nodes are completed or a real blocker remains.',
          'After validation passes, complete git finish-up: feature branch, commit, push, and PR creation/update via github_api (never gh CLI).',
          'After each push, query remote CI/check status via github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
          'Do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api, then keep iterating until the PR is merge-ready or a true blocker is reached.',
          'When finish-up fails, retry using the failure reason and continue from the same point.',
          'Implementation responses must end with 1-3 concrete next follow-up suggestions.',
          'Run verification and iterate until checks pass or a true blocker is reached.',
          'When blocked, report the blocker clearly and propose the best next step.',
        ];

  return renderPromptSections([
    {
      name: PromptSectionName.Identity,
      lines: [
        `You are an autonomous Orchestrace ${phase} agent for software tasks.`,
        'Operate safely, truthfully, and with high execution reliability.',
        'Think out loud: before every action, explain your reasoning, what you observed, what you plan to do next, and why.',
        'Narrate your thought process continuously so the user can follow your chain of thought in real time.',
        'When making decisions (e.g., choosing a tool, splitting tasks, picking an approach), explain the tradeoffs you considered.',
      ],
    },
    {
      name: PromptSectionName.AutonomyContract,
      lines: [
        'Never claim an action completed unless tool output confirms it.',
        'If context is missing, gather it with available tools before deciding.',
        'Prefer deterministic steps over speculative changes.',
      ],
    },
    {
      name: PromptSectionName.PhaseRules,
      lines: phaseRules,
    },
    {
      name: PromptSectionName.ExecutionContext,
      lines: [
        `Graph ID: ${graphId}`,
        `Task ID: ${task.id}`,
        `Task Name: ${task.name}`,
        `Task Type: ${task.type}`,
        `Workspace: ${cwd}`,
        `Model: ${provider}/${model}`,
        `Reasoning: ${reasoning ?? 'default'}`,
      ],
    },
  ]);
}

function determinePlanningMode(node: TaskNode): PlanningMode {
  const prompt = node.prompt.toLowerCase();

  const cleanupSignals = [
    'remove',
    'delete',
    'cleanup',
    'clean up',
    'prune',
    'drop',
    'strip',
    'eliminate',
    'remove references',
    'delete references',
    'dead code',
    'unused code',
    'unused import',
    'leftover',
  ];

  const simplicitySignals = [
    'all references',
    'search-and-delete',
    'grep',
    'no functional change',
    'no behavior change',
    'small',
    'minor',
    'targeted',
    'mechanical',
  ];

  const complexityBlockers = [
    'redesign',
    'architecture',
    'migrate',
    'migration',
    'rollout',
    'multi-step',
    'new feature',
    'introduce',
    'rewrite',
    'cross-cutting',
    'across',
    'public api',
    'breaking change',
    'database',
    'schema',
    'protocol',
    'performance',
    'security',
    'state machine',
  ];

  const hasComplexity = complexityBlockers.some((signal) => prompt.includes(signal));
  if (hasComplexity) {
    return 'full';
  }

  const cleanupCount = cleanupSignals.reduce((acc, signal) => acc + (prompt.includes(signal) ? 1 : 0), 0);
  const simplicityCount = simplicitySignals.reduce((acc, signal) => acc + (prompt.includes(signal) ? 1 : 0), 0);

  if (cleanupCount >= 2 || (cleanupCount >= 1 && simplicityCount >= 1)) {
    return 'fast';
  }

  return 'full';
}

function buildDependencyContext(depOutputs: Map<string, TaskOutput>): string {
  if (depOutputs.size === 0) {
    return 'No dependency outputs.';
  }

  return [
    'Dependency outputs:',
    ...[...depOutputs.entries()].map(
      ([id, output]) => `- ${id}: ${output.response ?? '(no textual output)'}`,
    ),
  ].join('\n');
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildPlanningTimeoutFallbackPlan(node: TaskNode): string {
  return [
    `Planning budget exhausted for task ${node.id} (${node.name}).`,
    'Forced transition to implementation with fallback plan to prevent additional planning overhead.',
    '',
    'Fallback steps:',
    '1) Read only task-relevant files.',
    '2) Apply minimal scoped edits required by the task prompt.',
    '3) Update related types/events if needed.',
    '4) Run validation commands and iterate until passing or blocked.',
  ].join('\n');
}

function isMeaningfulProgressToolEvent(event: LlmToolCallEvent): boolean {
  if (event.type !== 'result' || event.isError) {
    return false;
  }

  return event.toolName === 'write_file'
    || event.toolName === 'write_files'
    || event.toolName === 'edit_file'
    || event.toolName === 'edit_files'
    || event.toolName === 'run_command'
    || event.toolName === 'run_command_batch';
}

function createNoProgressTracker(maxNoProgressEvents: number): {
  getCount: () => number;
  reset: () => void;
  onNonProgressEvent: () => boolean;
  onToolCall: (event: LlmToolCallEvent) => boolean;
} {
  let consecutiveNoProgressEvents = 0;

  const incrementAndCheck = (): boolean => {
    consecutiveNoProgressEvents += 1;
    return consecutiveNoProgressEvents >= maxNoProgressEvents;
  };

  return {
    getCount: () => consecutiveNoProgressEvents,
    reset: () => {
      consecutiveNoProgressEvents = 0;
    },
    onNonProgressEvent: () => incrementAndCheck(),
    onToolCall: (event: LlmToolCallEvent) => {
      if (isMeaningfulProgressToolEvent(event)) {
        consecutiveNoProgressEvents = 0;
        return false;
      }

      return incrementAndCheck();
    },
  };
}

function truncateForRetry(text: string): string {
  if (text.length <= RETRY_CONTEXT_MAX_CHARS) return text;
  return text.slice(0, RETRY_CONTEXT_MAX_CHARS) + `\n... [truncated ${text.length - RETRY_CONTEXT_MAX_CHARS} chars]`;
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
  };
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
    || value === 'budget_exhausted'
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
  planningMode: PlanningMode,
): string | undefined {
  const hasSubAgentDelegation = hasSuccessfulToolCall(toolCalls, 'subagent_spawn')
    || hasSuccessfulToolCall(toolCalls, 'subagent_spawn_batch');
  const requiredTools = ['todo_set', 'agent_graph_set'];
  const missing = requiredTools.filter((toolName) => !hasSuccessfulToolCall(toolCalls, toolName));
  if (planningMode === 'full' && !hasSubAgentDelegation) {
    missing.push('subagent_spawn or subagent_spawn_batch');
  }

  const contractIssues: string[] = [];
  if (missing.length > 0) {
    contractIssues.push(`Missing successful coordination tool call(s): ${missing.join(', ')}.`);
  }

  const todoSetResult = latestSuccessfulToolCall(toolCalls, 'todo_set');
  if (todoSetResult) {
    const todoValidation = validateWeightedListPayload(todoSetResult.input, 'items');
    if (todoValidation.sum === undefined) {
      contractIssues.push('todo_set must include numeric weight for each item.');
    } else if (!isWeightTotalValid(todoValidation.sum)) {
      contractIssues.push(`todo_set item weights must sum to 100 (received ${formatWeightTotal(todoValidation.sum)}).`);
    }

    for (const issue of todoValidation.issues) {
      contractIssues.push(`todo_set ${issue}`);
    }
  }

  let graphNodeIds = new Set<string>();
  const graphSetResult = latestSuccessfulToolCall(toolCalls, 'agent_graph_set');
  if (graphSetResult) {
    const graphValidation = validateWeightedListPayload(graphSetResult.input, 'nodes');
    graphNodeIds = graphValidation.ids;
    if (graphValidation.sum === undefined) {
      contractIssues.push('agent_graph_set must include numeric weight for each node.');
    } else if (!isWeightTotalValid(graphValidation.sum)) {
      contractIssues.push(`agent_graph_set node weights must sum to 100 (received ${formatWeightTotal(graphValidation.sum)}).`);
    }

    for (const issue of graphValidation.issues) {
      contractIssues.push(`agent_graph_set ${issue}`);
    }
  }

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
    planningMode === 'fast'
      ? 'Planning must publish todo_set + agent_graph_set before implementation can begin.'
      : 'Planning must publish todo_set + agent_graph_set and delegate focused work via subagent_spawn before implementation can begin.',
  ].join(' ');
}

function hasSuccessfulToolCall(toolCalls: ReplayToolCallRecord[], toolName: string): boolean {
  return toolCalls.some((call) => call.status === 'result' && call.toolName === toolName && !call.isError);
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

const FALLBACK_WORKSPACE_GIT_SHA = 'unknown-workspace-sha';
const CACHEABLE_SUBAGENT_TOOLS = new Set(['subagent_spawn', 'subagent_spawn_batch']);
const execFileAsync = promisify(execFile);

async function resolveWorkspaceGitShaSafe(
  cwd: string,
  resolver?: (cwd: string) => Promise<string | undefined>,
): Promise<string> {
  if (resolver) {
    try {
      const resolved = (await resolver(cwd))?.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // fall through
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const resolved = stdout.trim();
    if (resolved) {
      return resolved;
    }
  } catch {
    // fall through
  }

  return FALLBACK_WORKSPACE_GIT_SHA;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortValue(entry));
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
      out[key] = stableSortValue(input[key]);
    }
    return out;
  }

  return value;
}

function hashPromptPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function buildSubAgentCacheKey(params: {
  toolName: string;
  args: Record<string, unknown>;
  workspaceGitSha: string;
}): string | undefined {
  if (!CACHEABLE_SUBAGENT_TOOLS.has(params.toolName)) {
    return undefined;
  }

  const nodeId = typeof params.args.nodeId === 'string' ? params.args.nodeId.trim() : '';
  if (!nodeId) {
    return undefined;
  }

  const promptHash = hashPromptPayload({
    prompt: params.args.prompt,
    contextPacket: params.args.contextPacket,
    systemPrompt: params.args.systemPrompt,
    provider: params.args.provider,
    model: params.args.model,
    reasoning: params.args.reasoning,
  });

  return `${nodeId}:${params.workspaceGitSha}:${promptHash}`;
}

function wrapToolsetWithSubAgentCache(params: {
  toolset?: LlmToolset;
  workspaceGitSha: string;
  cache: Map<string, LlmToolResult>;
}): LlmToolset | undefined {
  const { toolset, workspaceGitSha, cache } = params;
  if (!toolset) {
    return undefined;
  }

  return {
    tools: toolset.tools,
    executeTool: async (call: LlmToolCall, signal?: AbortSignal): Promise<LlmToolResult> => {
      if (!CACHEABLE_SUBAGENT_TOOLS.has(call.name)) {
        return toolset.executeTool(call, signal);
      }

      if (call.name === 'subagent_spawn') {
        const key = buildSubAgentCacheKey({
          toolName: call.name,
          args: call.arguments,
          workspaceGitSha,
        });

        if (key) {
          const cached = cache.get(key);
          if (cached) {
            return cached;
          }
        }

        const result = await toolset.executeTool(call, signal);
        if (!result.isError && key) {
          cache.set(key, result);
        }
        return result;
      }

      const rawAgents = call.arguments.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const cachedRuns: Record<string, unknown>[] = [];
      const misses: Record<string, unknown>[] = [];

      for (const raw of agents) {
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        const agent = raw as Record<string, unknown>;
        const key = buildSubAgentCacheKey({
          toolName: call.name,
          args: agent,
          workspaceGitSha,
        });
        if (!key) {
          misses.push(agent);
          continue;
        }

        const cached = cache.get(key);
        const parsed = cached ? parseToolCallInput(cached.content) : undefined;
        const runs = parsed && Array.isArray(parsed.runs) ? parsed.runs : [];
        const firstRun = runs[0];
        if (cached && !cached.isError && firstRun && typeof firstRun === 'object') {
          cachedRuns.push(firstRun as Record<string, unknown>);
          continue;
        }

        misses.push(agent);
      }

      if (misses.length === 0) {
        return {
          content: JSON.stringify({
            total: cachedRuns.length,
            completed: cachedRuns.length,
            failed: 0,
            failedNodeIds: [],
            runs: cachedRuns,
          }),
        };
      }

      const missResult = await toolset.executeTool(
        {
          ...call,
          arguments: {
            ...call.arguments,
            agents: misses,
          },
        },
        signal,
      );

      if (missResult.isError) {
        return missResult;
      }

      const parsedMiss = parseToolCallInput(missResult.content);
      const missRuns = parsedMiss && Array.isArray(parsedMiss.runs) ? parsedMiss.runs : [];

      for (const rawRun of missRuns) {
        if (!rawRun || typeof rawRun !== 'object') {
          continue;
        }
        const run = rawRun as Record<string, unknown>;
        if (run.status !== 'completed') {
          continue;
        }
        const runNodeId = typeof run.nodeId === 'string' ? run.nodeId.trim() : '';
        if (!runNodeId) {
          continue;
        }

        const sourceAgent = misses.find((agent) => {
          const nodeId = typeof agent.nodeId === 'string' ? agent.nodeId.trim() : '';
          return nodeId === runNodeId;
        });
        if (!sourceAgent) {
          continue;
        }

        const key = buildSubAgentCacheKey({
          toolName: call.name,
          args: sourceAgent,
          workspaceGitSha,
        });
        if (!key) {
          continue;
        }

        cache.set(key, {
          content: JSON.stringify({
            total: 1,
            completed: 1,
            failed: 0,
            failedNodeIds: [],
            runs: [run],
          }),
        });
      }

      if (cachedRuns.length === 0) {
        return missResult;
      }

      const liveRuns = missRuns.filter((run): run is Record<string, unknown> => Boolean(run && typeof run === 'object'));
      const mergedRuns = [...cachedRuns, ...liveRuns];
      const failedNodeIds = mergedRuns
        .filter((run) => run.status !== 'completed')
        .map((run) => run.nodeId)
        .filter((nodeId): nodeId is string => typeof nodeId === 'string');

      return {
        ...missResult,
        content: JSON.stringify({
          total: mergedRuns.length,
          completed: mergedRuns.length - failedNodeIds.length,
          failed: failedNodeIds.length,
          failedNodeIds,
          runs: mergedRuns,
        }),
      };
    },
  };
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
