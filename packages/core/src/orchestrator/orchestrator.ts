import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  TaskGraph,
  TaskNode,
  TaskOutput,
  RunnerConfig,
  ModelConfig,
} from '../dag/types.js';
import type { TaskExecutionContext } from '../dag/scheduler.js';
import { runDag } from '../dag/scheduler.js';
import { validate } from '../validation/validator.js';
import type { LlmAdapter } from '@orchestrace/provider';

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
  /** Max implementation attempts per task. Defaults to validation.maxRetries + 1. */
  maxImplementationAttempts?: number;
}

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
    requirePlanApproval,
    onPlanApproval,
    resolveApiKey,
    maxImplementationAttempts,
    onEvent,
  } = config;

  const emit = onEvent ?? (() => {});
  const originalNodesById = new Map(graph.nodes.map((node) => [node.id, node]));

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

    const planningAgent = await llm.spawnAgent({
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      systemPrompt:
        planningSystemPrompt
        ?? systemPrompt
        ?? 'You are a senior planning agent. Produce a deep, concrete implementation plan.',
      signal: context.signal,
      apiKey,
    });

    emit({ type: 'task:planning', taskId: node.id });

    const planningPrompt = buildPlanningPrompt(node, context.depOutputs);
    const planningResult = await planningAgent.complete(planningPrompt, context.signal);
    mergeUsage(usage, planningResult.usage);

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
          error: 'Plan approval is required but no approval handler was provided.',
          durationMs: Date.now() - start,
          retries: 0,
          usage,
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
          error: 'Plan was rejected by user approval gate.',
          durationMs: Date.now() - start,
          retries: 0,
          usage,
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
        ?? 'You are a coding agent. Implement the approved plan exactly and fix validation failures iteratively.',
      signal: context.signal,
      apiKey,
    });

    const taskRetryBudget = Math.max(0, node.validation?.maxRetries ?? 0);
    const maxAttempts = Math.max(
      1,
      maxImplementationAttempts ?? taskRetryBudget + 1,
    );

    let lastResponse = '';
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
        previousValidationError: lastValidationError,
      });

      const implResult = await implAgent.complete(implementationPrompt, context.signal);
      mergeUsage(usage, implResult.usage);
      lastResponse = implResult.text;

      const output: TaskOutput = {
        taskId: node.id,
        status: 'completed',
        plan: planningResult.text,
        planPath: persistedPlanPath,
        response: implResult.text,
        filesChanged: implResult.filesChanged,
        durationMs: Date.now() - start,
        retries: attempt - 1,
        usage,
      };

      if (!node.validation) {
        return output;
      }

      emit({ type: 'task:validating', taskId: node.id });
      const validationResults = await validate(output, node.validation, cwd);
      output.validationResults = validationResults;
      lastValidationResults = validationResults;
      const allPassed = validationResults.every((result) => result.passed);

      if (allPassed) {
        return output;
      }

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
      response: lastResponse,
      validationResults: lastValidationResults,
      error: lastValidationError || 'Implementation did not satisfy validation criteria.',
      durationMs: Date.now() - start,
      retries: maxAttempts - 1,
      usage,
    };
  };

  return runDag(managedRetryGraph, executor, {
    ...config,
    onEvent: emit,
  });
}

function buildPlanningPrompt(node: TaskNode, depOutputs: Map<string, TaskOutput>): string {
  const depContext = buildDependencyContext(depOutputs);
  return [
    'Create a deep implementation plan for the following task.',
    'Your plan must include:',
    '1) assumptions and constraints',
    '2) files likely to change',
    '3) ordered implementation steps',
    '4) verification strategy with explicit commands',
    '5) rollback/risk notes',
    '',
    `Task ID: ${node.id}`,
    `Task Name: ${node.name}`,
    `Task Type: ${node.type}`,
    '',
    'Task Prompt:',
    node.prompt,
    '',
    depContext,
  ].join('\n');
}

function buildImplementationPrompt(params: {
  node: TaskNode;
  depOutputs: Map<string, TaskOutput>;
  approvedPlan: string;
  attempt: number;
  previousResponse: string;
  previousValidationError: string;
}): string {
  const {
    node,
    depOutputs,
    approvedPlan,
    attempt,
    previousResponse,
    previousValidationError,
  } = params;

  const depContext = buildDependencyContext(depOutputs);
  const retryContext =
    attempt > 1
      ? [
          '',
          'Previous attempt response:',
          previousResponse || '(no response)',
          '',
          'Validation failures to fix:',
          previousValidationError || '(missing validation details)',
        ].join('\n')
      : '';

  return [
    'Execute the approved plan and implement the requested changes.',
    'You must satisfy validation criteria before considering the task complete.',
    '',
    `Attempt: ${attempt}`,
    `Task ID: ${node.id}`,
    `Task Name: ${node.name}`,
    '',
    'Original task prompt:',
    node.prompt,
    '',
    'Approved plan:',
    approvedPlan,
    '',
    depContext,
    retryContext,
  ].join('\n');
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
