import { validateGraph, getReadyTasks } from './graph.js';
import type {
  TaskGraph,
  TaskNode,
  TaskOutput,
  TaskState,
  RunnerConfig,
  DagEvent,
} from './types.js';

/**
 * Execute a task graph with dependency-aware parallel scheduling.
 *
 * Uses an event-driven pool: tasks are launched up to maxParallel,
 * and whenever any task settles, the pool refills with newly-ready tasks.
 */
export async function runDag(
  graph: TaskGraph,
  executor: (node: TaskNode, context: TaskExecutionContext) => Promise<TaskOutput>,
  config: RunnerConfig = {},
): Promise<Map<string, TaskOutput>> {
  validateGraph(graph);

  const maxParallel = config.maxParallel ?? 4;
  const emit = config.onEvent ?? (() => {});

  const completed = new Set<string>();
  const failed = new Set<string>();
  const inProgress = new Set<string>();
  const outputs = new Map<string, TaskOutput>();
  const states = new Map<string, TaskState>();

  for (const node of graph.nodes) {
    states.set(node.id, { node, status: 'pending', retryCount: 0 });
  }

  // Deferred promise that resolves when the entire graph is done
  let resolveAll!: (value: Map<string, TaskOutput>) => void;
  const allDone = new Promise<Map<string, TaskOutput>>((resolve) => {
    resolveAll = resolve;
  });

  function finishGraph(): void {
    if (failed.size > 0) {
      emit({
        type: 'graph:failed',
        error: `${failed.size} task(s) failed`,
        completedTasks: [...completed],
        failedTasks: [...failed],
      });
    } else {
      emit({ type: 'graph:completed', outputs });
    }
    resolveAll(outputs);
  }

  function scheduleReady(): void {
    if (completed.size + failed.size === graph.nodes.length) {
      finishGraph();
      return;
    }

    const ready = getReadyTasks(graph, completed, inProgress, failed);

    // Stuck: nothing ready, nothing in progress, but not all done
    if (ready.length === 0 && inProgress.size === 0) {
      const stuck = graph.nodes
        .filter((n) => !completed.has(n.id) && !failed.has(n.id))
        .map((n) => n.id);
      for (const id of stuck) {
        failed.add(id);
        outputs.set(id, {
          taskId: id,
          status: 'failed',
          error: 'Blocked by failed dependency',
          durationMs: 0,
          retries: 0,
        });
      }
      finishGraph();
      return;
    }

    const slots = maxParallel - inProgress.size;
    const toRun = ready.slice(0, Math.max(0, slots));

    for (const node of toRun) {
      emit({ type: 'task:ready', taskId: node.id });
      inProgress.add(node.id);
      launchTask(node);
    }
  }

  function onTaskDone(nodeId: string, output: TaskOutput): void {
    const state = states.get(nodeId)!;
    inProgress.delete(nodeId);

    if (output.status === 'completed') {
      state.status = 'completed';
      state.output = output;
      completed.add(nodeId);
      outputs.set(nodeId, output);
      emit({ type: 'task:completed', taskId: nodeId, output });
      scheduleReady();
      return;
    }

    // Failed — check retry
    const maxRetries = state.node.validation?.maxRetries ?? 0;
    if (state.retryCount < maxRetries) {
      state.retryCount++;
      state.status = 'retrying';
      emit({
        type: 'task:retrying',
        taskId: nodeId,
        attempt: state.retryCount,
        maxRetries,
      });
      const delay = state.node.validation?.retryDelayMs ?? 1000;
      inProgress.add(nodeId);
      if (delay > 0) {
        setTimeout(() => launchTask(state.node), delay);
      } else {
        // Use queueMicrotask to avoid synchronous recursion
        queueMicrotask(() => launchTask(state.node));
      }
      return;
    }

    state.status = 'failed';
    state.output = output;
    failed.add(nodeId);
    outputs.set(nodeId, output);
    const totalDurationMs = Math.max(0, Date.now() - (state.startedAt ?? Date.now()));
    emit({
      type: 'task:failed',
      taskId: nodeId,
      error: output.error ?? 'Unknown error',
      retries: state.retryCount,
      attempt: state.retryCount + 1,
      maxRetries,
      totalDurationMs,
      failureType: output.failureType,
    });
    scheduleReady();
  }

  function launchTask(node: TaskNode): void {
    const state = states.get(node.id)!;
    state.status = 'running';
    state.startedAt ??= Date.now();
    emit({ type: 'task:started', taskId: node.id });

    const depOutputs = new Map<string, TaskOutput>();
    for (const dep of node.dependencies) {
      const depOutput = outputs.get(dep);
      if (depOutput) depOutputs.set(dep, depOutput);
    }

    const context: TaskExecutionContext = {
      depOutputs,
      defaultModel: config.defaultModel,
      signal: config.signal,
    };

    executor(node, context).then(
      (output) => onTaskDone(node.id, output),
      (err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onTaskDone(node.id, {
          taskId: node.id,
          status: 'failed',
          error: errorMsg,
          durationMs: Date.now() - (state.startedAt ?? Date.now()),
          retries: state.retryCount,
        });
      },
    );
  }

  // Kick off
  scheduleReady();

  return allDone;
}

export interface TaskExecutionContext {
  depOutputs: Map<string, TaskOutput>;
  defaultModel?: RunnerConfig['defaultModel'];
  signal?: AbortSignal;
}
