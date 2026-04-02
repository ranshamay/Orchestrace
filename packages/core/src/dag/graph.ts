import type { TaskGraph, TaskNode } from './types.js';

/**
 * Validate the task graph: check for cycles, missing dependencies, duplicate IDs.
 * Throws on invalid graphs.
 */
export function validateGraph(graph: TaskGraph): void {
  const ids = new Set<string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      throw new Error(`Duplicate task ID: "${node.id}"`);
    }
    ids.add(node.id);
  }

  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`Task "${node.id}" depends on unknown task "${dep}"`);
      }
      if (dep === node.id) {
        throw new Error(`Task "${node.id}" depends on itself`);
      }
    }
  }

  // Kahn's algorithm for cycle detection
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }

  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      adj.get(dep)!.push(node.id);
      inDegree.set(node.id, inDegree.get(node.id)! + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(current)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (visited !== graph.nodes.length) {
    throw new Error('Task graph contains a cycle');
  }
}

/**
 * Return a topological ordering of the graph's tasks.
 * Tasks with no remaining dependencies appear first.
 */
export function topologicalSort(graph: TaskGraph): TaskNode[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const nodeMap = new Map<string, TaskNode>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
    nodeMap.set(node.id, node);
  }

  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      adj.get(dep)!.push(node.id);
      inDegree.set(node.id, inDegree.get(node.id)! + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: TaskNode[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(nodeMap.get(current)!);
    for (const neighbor of adj.get(current)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

/**
 * Given a set of completed task IDs, return all tasks whose dependencies
 * are fully satisfied and that haven't started yet.
 */
export function getReadyTasks(
  graph: TaskGraph,
  completed: Set<string>,
  inProgress: Set<string>,
  failed?: Set<string>,
): TaskNode[] {
  return graph.nodes.filter((node) => {
    if (completed.has(node.id) || inProgress.has(node.id)) return false;
    if (failed?.has(node.id)) return false;
    return node.dependencies.every((dep) => completed.has(dep));
  });
}
