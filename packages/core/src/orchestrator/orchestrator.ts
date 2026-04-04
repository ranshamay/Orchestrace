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
const DEFAULT_LONG_TURN_TIMEOUT_MS = 300_000;

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
      timeoutMs: resolvePlanningTurnTimeoutMs(),
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
    });

    emit({ type: 'task:planning', taskId: node.id });

    const planningPrompt = buildPlanningPrompt(node, context.depOutputs);
    const planningToolCalls: ReplayToolCallRecord[] = [];
    const planningAttemptStart = new Date().toISOString();
    let planningResult;
    try {
      planningResult = await planningAgent.complete(planningPrompt, context.signal, {
        onTextDelta: (delta) => {
          emit({
            type: 'task:stream-delta',
            taskId: node.id,
            phase: 'planning',
            attempt: 1,
            delta,
          });
        },
        onToolCall: (event) => {
          planningToolCalls.push(toReplayToolCallRecord(event));
          emit({
            type: 'task:tool-call',
            taskId: node.id,
            phase: 'planning',
            attempt: 1,
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
      const planningError = error instanceof Error ? error.message : String(error);
      const failedPlanningAttempt: ReplayAttemptRecord = {
        phase: 'planning',
        attempt: 1,
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
        attempt: 1,
        record: failedPlanningAttempt,
      });
      return {
        taskId: node.id,
        status: 'failed',
        tokenDumpDir: taskTokenDumpDir,
        error: planningError,
        failureType,
        durationMs: Date.now() - start,
        retries: 0,
        usage,
        replay,
      };
    }

    const completedPlanningAttempt: ReplayAttemptRecord = {
      phase: 'planning',
      attempt: 1,
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
      attempt: 1,
      record: completedPlanningAttempt,
    });

    mergeUsage(usage, planningResult.usage);
    await appendTokenDump(planningTokenDumpPath, {
      graphId: graph.id,
      taskId: node.id,
      agent: 'planning',
      attempt: 1,
      provider: model.provider,
      model: model.model,
      usage: planningResult.usage,
    });

    if (createToolset) {
      const planningContractError = buildPlanningContractError(planningToolCalls);
      if (planningContractError) {
        completedPlanningAttempt.failureType = 'validation';
        completedPlanningAttempt.error = planningContractError;
        emit({
          type: 'task:verification-failed',
          taskId: node.id,
          attempt: 1,
          error: planningContractError,
        });
        return {
          taskId: node.id,
          status: 'failed',
          tokenDumpDir: taskTokenDumpDir,
          error: planningContractError,
          failureType: 'validation',
          durationMs: Date.now() - start,
          retries: 0,
          usage,
          replay,
        };
      }
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
      timeoutMs: resolveImplementationTurnTimeoutMs(),
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
      ],
    },
    {
      name: PromptSectionName.Autonomy,
      lines: [
        'If a tool call fails, use the error details to correct arguments and retry instead of aborting.',
        'You MUST use coordination tools during planning:',
        '- todo_set (required) to create a concrete todo list',
        '- todo_update to track progress changes',
        '- agent_graph_set (required) to define sub-agent dependency graph',
        '- subagent_spawn/subagent_spawn_batch (required) to delegate focused planning research with only relevant context per sub-agent',
        '- pass nodeId on each sub-agent request so graph progress can be tracked per node',
      ],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'Your plan must include:',
        '1) assumptions and constraints',
        '2) multi-stage execution waves (stage 1..N)',
        '3) per-stage concurrent tasks and dependency boundaries',
        '4) files likely to change',
        '5) verification strategy with explicit commands',
        '6) rollback/risk notes',
        '7) a sub-agent delegation map aligned to agent_graph_set nodes and minimal per-agent context',
        '8) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions',
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
          previousResponse || '(no response)',
          '',
          'Validation failures to fix:',
          previousValidationError || '(missing validation details)',
        ].join('\n')
      : '';

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Goal,
      lines: [
        'Execute the approved plan and implement the requested changes.',
        'You must satisfy validation criteria before considering the task complete.',
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
        'When multiple independent nodes are ready, use subagent_spawn_batch to run them in parallel.',
        'Delegate only task-relevant context to each sub-agent; avoid sending full unrelated history.',
        'Pass nodeId for each spawned sub-agent so the execution graph can reflect live progress.',
        'Keep sub-agent outputs concise and integrate them into the main implementation.',
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
          'Planning must include successful todo_set and agent_graph_set tool calls.',
          'Planning must include successful subagent_spawn or subagent_spawn_batch calls with focused context per sub-agent.',
          'Planning responses must end with 1-3 concrete next follow-up suggestions.',
          'Return a plan that another agent could execute deterministically.',
        ]
      : [
          'Execute the approved plan and deliver validated code changes.',
          'Read relevant files before editing and keep edits minimal in scope.',
          'Use todo and agent graph state as the execution backbone, updating progress continuously.',
          'Use subagent_spawn or subagent_spawn_batch for parallelizable slices and delegate only relevant context to each sub-agent.',
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
  if (missing.length === 0) {
    return undefined;
  }

  return [
    'Planning contract not satisfied.',
    `Missing successful coordination tool call(s): ${missing.join(', ')}.`,
    'Planning must publish todo_set + agent_graph_set and delegate focused work via subagent_spawn before implementation can begin.',
  ].join(' ');
}

function hasSuccessfulToolCall(toolCalls: ReplayToolCallRecord[], toolName: string): boolean {
  return toolCalls.some((call) => call.status === 'result' && call.toolName === toolName && !call.isError);
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

function resolvePlanningTurnTimeoutMs(): number {
  return resolveConfiguredTimeoutMs(
    ['ORCHESTRACE_LLM_PLANNING_TIMEOUT_MS', 'ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS'],
    DEFAULT_LONG_TURN_TIMEOUT_MS,
  );
}

function resolveImplementationTurnTimeoutMs(): number {
  return resolveConfiguredTimeoutMs(
    ['ORCHESTRACE_LLM_DELEGATION_TIMEOUT_MS', 'ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS'],
    DEFAULT_LONG_TURN_TIMEOUT_MS,
  );
}

function resolveConfiguredTimeoutMs(envKeys: string[], fallbackMs: number): number {
  for (const key of envKeys) {
    const value = parsePositiveInt(process.env[key]);
    if (value) {
      return value;
    }
  }

  return fallbackMs;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}
