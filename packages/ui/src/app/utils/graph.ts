import type { WorkSession } from '../../lib/api';
import type { GraphNodeView } from '../types';
import { compactInline } from './text';
import { normalizeSessionStatus, normalizeTaskStatus } from './status';

function graphNodeLabel(node: { id: string; name?: string; prompt: string }): string {
  const name = (node.name ?? '').trim();
  if (name) {
    return compactInline(name, 32);
  }

  const compactId = node.id.trim();
  if (compactId && !/^n\d+$/i.test(compactId)) {
    return compactInline(compactId, 32);
  }

  return compactInline(node.prompt, 32);
}

export function buildGraphLayout(session?: WorkSession): { nodes: GraphNodeView[]; width: number; height: number } {
  if (!session) {
    return { nodes: [], width: 900, height: 520 };
  }

  let baseNodes = session.agentGraph && session.agentGraph.length > 0
    ? session.agentGraph
    : [{ id: session.id, prompt: session.prompt, dependencies: [] }];

  const statusById = new Map(baseNodes.map((node) => [node.id, node.status ?? normalizeTaskStatus(session.taskStatus[node.id])]));
  const isRunning = normalizeSessionStatus(session.status) === 'running';
  const hasRunningNode = [...statusById.values()].some((status) => status === 'running');
  if (isRunning && !hasRunningNode) {
    const readyPending = baseNodes.find((node) => {
      const status = statusById.get(node.id) ?? 'pending';
      if (status === 'completed' || status === 'failed') {
        return false;
      }
      return (node.dependencies ?? []).every((dep) => (statusById.get(dep) ?? 'pending') === 'completed');
    });

    if (readyPending) {
      statusById.set(readyPending.id, 'running');
    } else if (baseNodes.length > 0) {
      const syntheticId = '__orchestrator__';
      if (!baseNodes.find((node) => node.id === syntheticId)) {
        baseNodes = [...baseNodes, {
          id: syntheticId,
          name: 'orchestrator',
          prompt: session.llmStatus?.detail || 'Coordinating remaining workflow tasks.',
          dependencies: baseNodes.map((node) => node.id),
          status: 'running' as const,
        }];
      }
      statusById.set(syntheticId, 'running');
    }
  }

  const nodeById = new Map(baseNodes.map((node) => [node.id, node]));
  const levelById = new Map<string, number>();
  const computeLevel = (id: string, trail = new Set<string>()): number => {
    if (levelById.has(id)) return levelById.get(id) ?? 0;
    if (trail.has(id)) return 0;
    trail.add(id);
    const node = nodeById.get(id);
    if (!node || node.dependencies.length === 0) return 0;
    const level = Math.max(...node.dependencies.map((dep) => computeLevel(dep, trail) + 1));
    levelById.set(id, level);
    trail.delete(id);
    return level;
  };

  for (const node of baseNodes) computeLevel(node.id);
  const levelGroups = new Map<number, typeof baseNodes>();
  for (const node of baseNodes) {
    const level = levelById.get(node.id) ?? 0;
    levelGroups.set(level, [...(levelGroups.get(level) ?? []), node]);
  }

  const levels = [...levelGroups.keys()].sort((a, b) => a - b);
  const maxPerLevel = Math.max(1, ...[...levelGroups.values()].map((group) => group.length));
  const width = Math.max(900, levels.length * 280 + 180);
  const height = Math.max(520, maxPerLevel * 140 + 180);

  const nodes: GraphNodeView[] = [];
  for (const level of levels) {
    const group = levelGroups.get(level) ?? [];
    const stepY = height / (group.length + 1);
    group.forEach((node, index) => {
      const status = statusById.get(node.id) ?? normalizeTaskStatus(session.taskStatus[node.id]);
      nodes.push({ id: node.id, label: graphNodeLabel(node), prompt: node.prompt, x: 130 + level * 260, y: stepY * (index + 1), status: node.status ?? status, dependencies: node.dependencies });
    });
  }

  return { nodes, width, height };
}