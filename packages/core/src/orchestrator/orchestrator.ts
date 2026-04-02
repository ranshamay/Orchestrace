import type { TaskGraph, TaskNode, TaskOutput, RunnerConfig, ModelConfig } from '../dag/types.js';
import type { TaskExecutionContext } from '../dag/scheduler.js';
import { runDag } from '../dag/scheduler.js';
import { validate } from '../validation/validator.js';
import type { LlmAdapter } from '@orchestrace/provider';

export interface OrchestratorConfig extends RunnerConfig {
  /** LLM adapter for executing agent tasks. */
  llm: LlmAdapter;
  /** Working directory for validation commands. */
  cwd: string;
  /** System prompt prepended to all agent calls. */
  systemPrompt?: string;
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
  const { llm, cwd, systemPrompt } = config;

  const executor = async (
    node: TaskNode,
    context: TaskExecutionContext,
  ): Promise<TaskOutput> => {
    const start = Date.now();
    const model: ModelConfig = node.model ?? context.defaultModel ?? {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };

    // Build the prompt with dependency context
    let fullPrompt = node.prompt;
    if (context.depOutputs.size > 0) {
      const depContext = [...context.depOutputs.entries()]
        .map(([id, out]) => `## Output from "${id}":\n${out.response ?? '(no output)'}`)
        .join('\n\n');
      fullPrompt = `${depContext}\n\n---\n\n${fullPrompt}`;
    }

    // Call the LLM
    const llmResult = await llm.complete({
      provider: model.provider,
      model: model.model,
      systemPrompt: systemPrompt ?? 'You are a coding agent. Follow instructions precisely.',
      prompt: fullPrompt,
      reasoning: model.reasoning,
      signal: context.signal,
    });

    const output: TaskOutput = {
      taskId: node.id,
      status: 'completed',
      response: llmResult.text,
      filesChanged: llmResult.filesChanged,
      durationMs: Date.now() - start,
      usage: llmResult.usage,
      retries: 0,
    };

    // Run validation if configured
    if (node.validation) {
      const results = await validate(output, node.validation, cwd);
      output.validationResults = results;
      const allPassed = results.every((r) => r.passed);
      if (!allPassed) {
        output.status = 'failed';
        output.error = results
          .filter((r) => !r.passed)
          .map((r) => `${r.command}: ${r.output}`)
          .join('\n');
      }
    }

    return output;
  };

  return runDag(graph, executor, config);
}
