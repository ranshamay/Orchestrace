import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { orchestrate } from '@orchestrace/core';
import type { TaskGraph, DagEvent } from '@orchestrace/core';
import { PiAiAdapter } from '@orchestrace/provider';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
orchestrace — DAG-based agent orchestration

Usage:
  orchestrace run <plan.json>   Execute a task graph from a JSON plan file
  orchestrace --help            Show this help

Plan file format:
  {
    "id": "my-plan",
    "name": "Feature implementation",
    "nodes": [
      {
        "id": "plan",
        "name": "Create implementation plan",
        "type": "plan",
        "prompt": "Analyze the codebase and create a plan for...",
        "dependencies": [],
        "model": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "reasoning": "high" }
      },
      {
        "id": "implement",
        "name": "Implement the feature",
        "type": "code",
        "prompt": "Implement the feature based on the plan...",
        "dependencies": ["plan"],
        "validation": {
          "commands": ["pnpm tsc --noEmit", "pnpm vitest run"],
          "maxRetries": 2,
          "retryDelayMs": 2000
        }
      }
    ]
  }

Environment variables:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.
  ORCHESTRACE_DEFAULT_PROVIDER   Default LLM provider (default: anthropic)
  ORCHESTRACE_DEFAULT_MODEL      Default model ID
  ORCHESTRACE_MAX_PARALLEL       Max concurrent tasks (default: 4)
`);
    process.exit(0);
  }

  const command = args[0];

  if (command === 'run') {
    const planPath = args[1];
    if (!planPath) {
      console.error('Error: missing plan file path');
      process.exit(1);
    }

    const absolutePath = resolve(planPath);
    const raw = await readFile(absolutePath, 'utf-8');
    const graph: TaskGraph = JSON.parse(raw);

    const maxParallel = parseInt(process.env.ORCHESTRACE_MAX_PARALLEL ?? '4', 10);
    const provider = process.env.ORCHESTRACE_DEFAULT_PROVIDER ?? 'anthropic';
    const model = process.env.ORCHESTRACE_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';

    console.log(`\n▶ Running plan: ${graph.name} (${graph.nodes.length} tasks, max ${maxParallel} parallel)\n`);

    const onEvent = (event: DagEvent) => {
      const ts = new Date().toISOString().slice(11, 19);
      switch (event.type) {
        case 'task:ready':
          console.log(`  [${ts}] ◇ ready:     ${event.taskId}`);
          break;
        case 'task:started':
          console.log(`  [${ts}] ▶ started:   ${event.taskId}`);
          break;
        case 'task:completed':
          console.log(`  [${ts}] ✓ completed: ${event.taskId} (${event.output.durationMs}ms)`);
          break;
        case 'task:failed':
          console.log(`  [${ts}] ✗ failed:    ${event.taskId} — ${event.error}`);
          break;
        case 'task:retrying':
          console.log(`  [${ts}] ↻ retrying:  ${event.taskId} (attempt ${event.attempt}/${event.maxRetries})`);
          break;
        case 'graph:completed':
          console.log(`\n✓ Plan completed. ${event.outputs.size} task(s) finished.`);
          break;
        case 'graph:failed':
          console.log(`\n✗ Plan failed: ${event.error}`);
          console.log(`  Completed: ${event.completedTasks.join(', ') || 'none'}`);
          console.log(`  Failed:    ${event.failedTasks.join(', ')}`);
          break;
      }
    };

    const llm = new PiAiAdapter();
    const cwd = process.cwd();

    const outputs = await orchestrate(graph, {
      llm,
      cwd,
      maxParallel,
      defaultModel: { provider, model },
      onEvent,
    });

    // Summary
    let totalTokens = 0;
    let totalCost = 0;
    for (const output of outputs.values()) {
      if (output.usage) {
        totalTokens += output.usage.input + output.usage.output;
        totalCost += output.usage.cost;
      }
    }

    if (totalTokens > 0) {
      console.log(`\nTokens: ${totalTokens.toLocaleString()} | Cost: $${totalCost.toFixed(4)}`);
    }

    const anyFailed = [...outputs.values()].some((o) => o.status === 'failed');
    process.exit(anyFailed ? 1 : 0);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
