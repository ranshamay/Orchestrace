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
import { PromptSectionName, renderPromptSections, type PromptSection } from '../prompt/sections.js';
import type { LlmAdapter, LlmToolCallEvent, LlmToolset } from '@orchestrace/provider';

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
}

type OrchestratorPhase = 'planning' | 'implementation';

const DEFAULT_ORCHESTRATOR_PROMPT_VERSION = 'orchestrator-prompts-v2';
const MAX_PLANNING_ATTEMPTS = 3;
const PLANNING_RETRY_BASE_DELAY_MS = 2_000;
const RETRY_CONTEXT_MAX_CHARS = 2_000;
const PLANNING_STALL_MAX_CONSECUTIVE_DELTAS = 5;
const PLANNING_STALL_NUDGE =
  'You appear to be stuck in planning. Please proceed with a concrete tool call or finalize your output.';
const PLANNING_STALL_ABORT_SENTINEL = '__orchestrace_planning_stall__';

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
      toolset: createToolset?.({
        phase: 'planning',
        task: node,
        graphId: graph.id,
        cwd,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
      }),
      apiKey,
      refreshApiKey,
    });

    emit({ type: 'task:planning', taskId: node.id });

    const planningPrompt = buildPlanningPrompt(node, context.depOutputs);
    let planningAttemptPrompt = planningPrompt;
    let planningResult;
    let planningToolCalls: ReplayToolCallRecord[] = [];

    for (let planningAttempt = 1; planningAttempt <= MAX_PLANNING_ATTEMPTS; planningAttempt++) {
      planningToolCalls = [];
      const planningAttemptStart = new Date().toISOString();
      planningResult = undefined;

      const planningAttemptController = new AbortController();
      const planningStallAbortController = () => {
        if (!planningAttemptController.signal.aborted) {
          planningAttemptController.abort(createPlanningStallAbortError());
        }
      };
      const abortPlanningAttemptOnParentCancel = () => {
        planningAttemptController.abort(context.signal?.reason);
      };
      context.signal?.addEventListener('abort', abortPlanningAttemptOnParentCancel, { once: true });

      let planningConsecutiveTextDeltas = 0;
      let planningStallTriggered = false;

      try {
        planningResult = await planningAgent.complete(planningAttemptPrompt, planningAttemptController.signal, {
          onTextDelta: (delta) => {
            planningConsecutiveTextDeltas += 1;
            if (planningConsecutiveTextDeltas > PLANNING_STALL_MAX_CONSECUTIVE_DELTAS) {
              planningStallTriggered = true;
              planningStallAbortController();
              return;
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
            planningConsecutiveTextDeltas = 0;
            planningToolCalls.push(toReplayToolCallRecord(event));
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
        });
      } catch (error) {
        const failureType = resolveReplayFailureType(error);
        const wasPlanningStallAbort = planningStallTriggered || isPlanningStallAbortError(error);
        const planningError = wasPlanningStallAbort
          ? `Planning appeared stuck after ${PLANNING_STALL_MAX_CONSECUTIVE_DELTAS + 1} consecutive thinking cycles without tool calls. ${PLANNING_STALL_NUDGE}`
          : error instanceof Error ? error.message : String(error);
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
          if (wasPlanningStallAbort) {
            planningAttemptPrompt = withPlanningStallNudge(planningPrompt);
          }
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
      } finally {
        context.signal?.removeEventListener('abort', abortPlanningAttemptOnParentCancel);
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
        const planningContractError = buildPlanningContractError(planningToolCalls);
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

    const persistedPlanPath = await persistPlan({
      baseDir: planOutputDir ?? join(cwd, '.orchestrace', 'plans'),
      graphId: graph.id,
      node,
      plan: planningResult.text,
    });
    emit({ type: 'task:plan-persisted', taskId: node.id, path: persistedPlanPath });

    const needsApproval = requirePlanApproval ?? true;
    if (needsApproval) {
      emit({ type: 'task:approval-requested', taskId: node.id, path: persistedPlanPath });
      if (!onPlanApproval) {
        return {
          taskId: node.id,
          status: 'failed',
          plan: planningResult.text,
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
        plan: planningResult.text,
        planPath: persistedPlanPath,
      });

      if (!approved) {
        return {
          taskId: node.id,
          status: 'failed',
          plan: planningResult.text,
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
      toolset: createToolset?.({
        phase: 'implementation',
        task: node,
        graphId: graph.id,
        cwd,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
      }),
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
        approvedPlan: planningResult.text,
        attempt,
        previousResponse: lastResponse,
        previousFailureType: lastFailureType,
        previousValidationError: lastValidationError,
      });

      const implementationToolCalls: ReplayToolCallRecord[] = [];
      const implementationAttemptStart = new Date().toISOString();
      let implResult;
      try {
        implResult = await implAgent.complete(implementationPrompt, context.signal, {
          onTextDelta: (delta) => {
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
        plan: planningResult.text,
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
      plan: planningResult.text,
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

function buildPlanningPrompt(node: TaskNode, depOutputs: Map<string, TaskOutput>): string {
  const depContext = buildDependencyContext(depOutputs);
  return renderPromptSections([
    {
      name: PromptSectionName.Goal,
      lines: [
        'Create a deep implementation plan for the following task.',
        'Optimize for maximum safe concurrency and explicit multi-stage execution.',
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
        '- subagent_spawn/subagent_spawn_batch (required) to delegate focused planning research with only relevant context per sub-agent',
        '- ALWAYS use subagent_spawn_batch (not individual subagent_spawn calls) when multiple independent sub-agents can run concurrently',
        '- subagent_spawn/subagent_spawn_batch calls must include nodeId values that map back to agent_graph_set node ids',
        '- pass nodeId on each sub-agent request so graph progress can be tracked per node',
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
        '7) a sub-agent delegation map aligned to agent_graph_set nodes and minimal per-agent context',
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

function truncateForRetry(text: string): string {
  if (text.length <= RETRY_CONTEXT_MAX_CHARS) return text;
  return text.slice(0, RETRY_CONTEXT_MAX_CHARS) + `\n... [truncated ${text.length - RETRY_CONTEXT_MAX_CHARS} chars]`;
}

function withPlanningStallNudge(basePrompt: string): string {
  return `${basePrompt}\n\n[Planning Stall Recovery]\n${PLANNING_STALL_NUDGE}`;
}

function createPlanningStallAbortError(): Error {
  const error = new Error(PLANNING_STALL_ABORT_SENTINEL);
  (error as Error & { failureType?: ReplayFailureType }).failureType = 'empty_response';
  return error;
}

function isPlanningStallAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === PLANNING_STALL_ABORT_SENTINEL;
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

function buildPlanningContractError(toolCalls: ReplayToolCallRecord[]): string | undefined {
  const hasSubAgentDelegation = hasSuccessfulToolCall(toolCalls, 'subagent_spawn')
    || hasSuccessfulToolCall(toolCalls, 'subagent_spawn_batch');
  const requiredTools = ['todo_set', 'agent_graph_set'];
  const missing = requiredTools.filter((toolName) => !hasSuccessfulToolCall(toolCalls, toolName));
  if (!hasSubAgentDelegation) {
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
    'Planning must publish todo_set + agent_graph_set and delegate focused work via subagent_spawn before implementation can begin.',
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
