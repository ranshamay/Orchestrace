import { describe, it, expect } from 'vitest';
import { validateGraph, topologicalSort, getReadyTasks } from '../../src/dag/graph.js';
import type { TaskGraph } from '../../src/dag/types.js';

function makeGraph(nodes: TaskGraph['nodes']): TaskGraph {
  return { id: 'test', name: 'Test Graph', nodes };
}

function node(id: string, deps: string[] = []) {
  return { id, name: id, type: 'code' as const, prompt: `do ${id}`, dependencies: deps };
}

describe('validateGraph', () => {
  it('passes for a valid DAG', () => {
    const graph = makeGraph([node('a'), node('b', ['a']), node('c', ['a', 'b'])]);
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it('rejects duplicate IDs', () => {
    const graph = makeGraph([node('a'), node('a')]);
    expect(() => validateGraph(graph)).toThrow('Duplicate task ID: "a"');
  });

  it('rejects unknown dependencies', () => {
    const graph = makeGraph([node('a', ['missing'])]);
    expect(() => validateGraph(graph)).toThrow('depends on unknown task "missing"');
  });

  it('rejects self-dependencies', () => {
    const graph = makeGraph([node('a', ['a'])]);
    expect(() => validateGraph(graph)).toThrow('depends on itself');
  });

  it('detects cycles', () => {
    const graph = makeGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])]);
    expect(() => validateGraph(graph)).toThrow('contains a cycle');
  });

  it('detects two-node cycle', () => {
    const graph = makeGraph([node('a', ['b']), node('b', ['a'])]);
    expect(() => validateGraph(graph)).toThrow('contains a cycle');
  });
});

describe('topologicalSort', () => {
  it('returns nodes in dependency order', () => {
    const graph = makeGraph([node('c', ['b']), node('a'), node('b', ['a'])]);
    const sorted = topologicalSort(graph);
    const ids = sorted.map((n) => n.id);

    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('handles independent nodes', () => {
    const graph = makeGraph([node('a'), node('b'), node('c')]);
    const sorted = topologicalSort(graph);
    expect(sorted).toHaveLength(3);
  });

  it('handles diamond dependencies', () => {
    const graph = makeGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    const sorted = topologicalSort(graph);
    const ids = sorted.map((n) => n.id);

    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
  });
});

describe('getReadyTasks', () => {
  it('returns root nodes initially', () => {
    const graph = makeGraph([node('a'), node('b', ['a']), node('c')]);
    const ready = getReadyTasks(graph, new Set(), new Set());
    const ids = ready.map((n) => n.id);

    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b');
  });

  it('unblocks dependents when deps complete', () => {
    const graph = makeGraph([node('a'), node('b', ['a'])]);
    const ready = getReadyTasks(graph, new Set(['a']), new Set());

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('b');
  });

  it('excludes in-progress tasks', () => {
    const graph = makeGraph([node('a'), node('b')]);
    const ready = getReadyTasks(graph, new Set(), new Set(['a']));

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('b');
  });

  it('returns empty when all blocked', () => {
    const graph = makeGraph([node('a', ['b']), node('b', ['a'])]);
    // This graph is cyclic but getReadyTasks doesn't validate.
    // Both tasks depend on each other → nothing is ready.
    const ready = getReadyTasks(graph, new Set(), new Set());
    expect(ready).toHaveLength(0);
  });
});
