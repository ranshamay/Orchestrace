import { describe, it, expect } from 'vitest';
import { runDag } from '../../src/dag/scheduler.js';
import type { TaskGraph, TaskNode, TaskOutput, DagEvent } from '../../src/dag/types.js';
import type { TaskExecutionContext } from '../../src/dag/scheduler.js';

function makeGraph(nodes: TaskGraph['nodes']): TaskGraph {
  return { id: 'test', name: 'Test Graph', nodes };
}

function node(id: string, deps: string[] = []): TaskNode {
  return { id, name: id, type: 'code', prompt: `do ${id}`, dependencies: deps };
}

function okOutput(id: string): TaskOutput {
  return { taskId: id, status: 'completed', response: `done: ${id}`, durationMs: 1, retries: 0 };
}

describe('runDag', () => {
  it('executes a linear chain in order', async () => {
    const order: string[] = [];
    const graph = makeGraph([node('a'), node('b', ['a']), node('c', ['b'])]);

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      order.push(n.id);
      return okOutput(n.id);
    };

    const outputs = await runDag(graph, executor);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(outputs.size).toBe(3);
    expect(outputs.get('c')!.status).toBe('completed');
  });

  it('runs independent tasks concurrently', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const graph = makeGraph([node('a'), node('b'), node('c'), node('d')]);

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      started.push(n.id);
      await Promise.resolve();
      finished.push(n.id);
      return okOutput(n.id);
    };

    await runDag(graph, executor, { maxParallel: 4 });
    expect(started.length).toBe(4);
    expect(finished.length).toBe(4);
  });

  it('limits concurrency to maxParallel', async () => {
    let concurrent = 0;
    let maxSeen = 0;
    const graph = makeGraph([node('a'), node('b'), node('c'), node('d')]);

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      await Promise.resolve();
      concurrent--;
      return okOutput(n.id);
    };

    await runDag(graph, executor, { maxParallel: 2 });
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(maxSeen).toBeGreaterThanOrEqual(1);
  });

  it('retries failed tasks', async () => {
    let attempts = 0;
    const graph = makeGraph([
      { ...node('flaky'), validation: { maxRetries: 2, retryDelayMs: 0 } },
    ]);

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      attempts++;
      if (attempts < 3) {
        return { taskId: n.id, status: 'failed', error: 'flaky', durationMs: 1, retries: 0 };
      }
      return okOutput(n.id);
    };

    const outputs = await runDag(graph, executor);
    expect(outputs.get('flaky')!.status).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('marks blocked tasks as failed when dep fails', async () => {
    const graph = makeGraph([node('a'), node('b', ['a'])]);

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      return { taskId: n.id, status: 'failed', error: 'nope', durationMs: 1, retries: 0 };
    };

    const outputs = await runDag(graph, executor);
    expect(outputs.get('a')!.status).toBe('failed');
    expect(outputs.get('b')!.status).toBe('failed');
    expect(outputs.get('b')!.error).toContain('Blocked by failed dependency');
  });

  it('emits retry metadata on terminal task:failed events', async () => {
    const graph = makeGraph([
      { ...node('flaky'), validation: { maxRetries: 2, retryDelayMs: 0 } },
    ]);
    const failedEvents: Extract<DagEvent, { type: 'task:failed' }>[] = [];

    const executor = async (n: TaskNode): Promise<TaskOutput> => {
      return { taskId: n.id, status: 'failed', error: 'still failing', durationMs: 1, retries: 0 };
    };

    await runDag(graph, executor, {
      onEvent: (event) => {
        if (event.type === 'task:failed') failedEvents.push(event);
      },
    });

    expect(failedEvents).toHaveLength(1);
    const failedEvent = failedEvents[0];
    expect(failedEvent.retries).toBe(2);
    expect(failedEvent.attempt).toBe(3);
    expect(failedEvent.maxRetries).toBe(2);
    expect(failedEvent.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits retry metadata when executor throws and retries are exhausted', async () => {
    const graph = makeGraph([
      { ...node('throws'), validation: { maxRetries: 1, retryDelayMs: 0 } },
    ]);
    const failedEvents: Extract<DagEvent, { type: 'task:failed' }>[] = [];

    const executor = async (): Promise<TaskOutput> => {
      throw new Error('kaboom');
    };

    await runDag(graph, executor, {
      onEvent: (event) => {
        if (event.type === 'task:failed') failedEvents.push(event);
      },
    });

    expect(failedEvents).toHaveLength(1);
    const failedEvent = failedEvents[0];
    expect(failedEvent.error).toBe('kaboom');
    expect(failedEvent.retries).toBe(1);
    expect(failedEvent.attempt).toBe(2);
    expect(failedEvent.maxRetries).toBe(1);
    expect(failedEvent.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits lifecycle events', async () => {
    const events: DagEvent['type'][] = [];
    const graph = makeGraph([node('a')]);

    await runDag(graph, async (n) => okOutput(n.id), {
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toContain('task:ready');
    expect(events).toContain('task:started');
    expect(events).toContain('task:completed');
    expect(events).toContain('graph:completed');
  });

  it('passes dependency outputs to executor', async () => {
    const graph = makeGraph([node('a'), node('b', ['a'])]);
    let receivedDeps: Map<string, TaskOutput> | undefined;

    const executor = async (n: TaskNode, ctx: TaskExecutionContext): Promise<TaskOutput> => {
      if (n.id === 'b') receivedDeps = ctx.depOutputs;
      return { taskId: n.id, status: 'completed', response: `out-${n.id}`, durationMs: 1, retries: 0 };
    };

    await runDag(graph, executor);
    expect(receivedDeps).toBeDefined();
    expect(receivedDeps!.get('a')!.response).toBe('out-a');
  });
});
