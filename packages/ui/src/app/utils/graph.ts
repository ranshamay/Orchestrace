import type { WorkSession } from '../../lib/api';
import type { GraphNodeView } from '../types';
import { compactInline } from './text';
import { normalizeSessionStatus, normalizeTaskStatus } from './status';

function graphNodeLabel(node: { id: string; name?: string; prompt: string }): string {
  const name = (node.name ?? '').trim();
  if (name) {
    return compactInline(name, 42);
  }

  const compactId = node.id.trim();
  if (compactId && !/^n\d+$/i.test(compactId)) {
    return compactInline(compactId, 42);
  }

  return compactInline(node.prompt, 42);
}

/**
 * When no explicit agent graph exists, derive a lifecycle graph from session events.
 * Produces sequential nodes: Planning → Implementation → Testing → Verification.
 */
function deriveLifecycleGraph(session: WorkSession): { id: string; name: string; prompt: string; dependencies: string[]; status: 'pending' | 'running' | 'completed' | 'failed' }[] {
  const events = session.events ?? [];
  const eventTypes = new Set(events.map((e) => e.type));
  const sessionStatus = normalizeSessionStatus(session.status);

  const phases: { id: string; name: string; prompt: string; deps: string[]; detected: boolean }[] = [
    { id: 'planning', name: 'Planning', prompt: 'Analyze prompt and generate execution plan', deps: [], detected: eventTypes.has('task:planning') || eventTypes.has('task:plan-persisted') || eventTypes.has('task:approval-requested') },
    { id: 'implementation', name: 'Implementation', prompt: 'Implement the planned changes', deps: ['planning'], detected: eventTypes.has('task:implementation-attempt') || eventTypes.has('task:approved') },
    { id: 'testing', name: 'Testing', prompt: 'Run tests to validate implementation', deps: ['implementation'], detected: eventTypes.has('task:testing') || eventTypes.has('task:tester-verdict') },
    { id: 'verification', name: 'Verification', prompt: 'Verify and finalize changes', deps: ['implementation'], detected: eventTypes.has('task:validating') || eventTypes.has('task:verification-failed') },
  ];

  // Include phases that were detected or are expected based on session state
  const activePhases = phases.filter((p) => p.detected || sessionStatus === 'running' || sessionStatus === 'completed');
  if (activePhases.length === 0) {
    return [{ id: session.id, name: compactInline(session.prompt, 42), prompt: session.prompt, dependencies: [], status: 'pending' }];
  }

  // Derive status per phase from events
  const getPhaseStatus = (phaseId: string): 'pending' | 'running' | 'completed' | 'failed' => {
    switch (phaseId) {
      case 'planning': {
        if (eventTypes.has('task:approved') || eventTypes.has('task:implementation-attempt')) return 'completed';
        if (eventTypes.has('task:planning') || eventTypes.has('task:plan-persisted') || eventTypes.has('task:approval-requested')) return 'running';
        if (sessionStatus === 'running') return 'running';
        return 'pending';
      }
      case 'implementation': {
        if (eventTypes.has('task:testing') || eventTypes.has('task:tester-verdict') || eventTypes.has('task:validating')) return 'completed';
        const lastImplEvent = [...events].reverse().find((e) => e.type === 'task:implementation-attempt');
        if (lastImplEvent) return 'running';
        if (eventTypes.has('task:approved')) return 'running';
        return 'pending';
      }
      case 'testing': {
        const lastVerdict = [...events].reverse().find((e) => e.type === 'task:tester-verdict');
        if (lastVerdict) return (lastVerdict as { testsFailed?: number }).testsFailed === 0 ? 'completed' : 'failed';
        if (eventTypes.has('task:testing')) return 'running';
        return 'pending';
      }
      case 'verification': {
        if (sessionStatus === 'completed') return 'completed';
        if (eventTypes.has('task:verification-failed')) return 'failed';
        if (eventTypes.has('task:validating')) return 'running';
        return 'pending';
      }
      default:
        return 'pending';
    }
  };

  // Fix deps to only reference phases actually in the list
  const activeIds = new Set(activePhases.map((p) => p.id));
  // If testing exists, make verification depend on testing instead of implementation
  if (activeIds.has('testing') && activeIds.has('verification')) {
    const verPhase = activePhases.find((p) => p.id === 'verification');
    if (verPhase) verPhase.deps = ['testing'];
  }

  if (sessionStatus === 'failed') {
    // Mark uncompleted phases correctly
    return activePhases.map((p) => {
      const status = getPhaseStatus(p.id);
      return {
        id: p.id, name: p.name, prompt: p.prompt,
        dependencies: p.deps.filter((d) => activeIds.has(d)),
        status: status === 'running' ? 'failed' : status,
      };
    });
  }

  return activePhases.map((p) => ({
    id: p.id, name: p.name, prompt: p.prompt,
    dependencies: p.deps.filter((d) => activeIds.has(d)),
    status: sessionStatus === 'completed' ? 'completed' : getPhaseStatus(p.id),
  }));
}

export function buildGraphLayout(session?: WorkSession): { nodes: GraphNodeView[]; width: number; height: number } {
  if (!session) {
    return { nodes: [], width: 900, height: 520 };
  }

  const baseNodes = session.agentGraph && session.agentGraph.length > 0
    ? session.agentGraph
    : deriveLifecycleGraph(session);

  const statusById = new Map(baseNodes.map((node) => [node.id, node.status ?? normalizeTaskStatus(session.taskStatus[node.id])]));
  const sessionNormalized = normalizeSessionStatus(session.status);
  const isRunning = sessionNormalized === 'running';
  const isCompleted = sessionNormalized === 'completed';
  const isTerminal = sessionNormalized === 'failed' || sessionNormalized === 'cancelled';

  // When the session completed, any unfinished node should be treated as completed.
  // This prevents stale running/pending node badges after the run is done.
  if (isCompleted) {
    for (const node of baseNodes) {
      const status = statusById.get(node.id) ?? 'pending';
      if (status === 'running' || status === 'pending') {
        statusById.set(node.id, 'completed');
      }
    }
  }

  // When the session is terminal, demote any still-running nodes to failed
  // and leave pending nodes as pending (they never started).
  if (isTerminal) {
    for (const node of baseNodes) {
      const status = statusById.get(node.id) ?? 'pending';
      if (status === 'running') {
        statusById.set(node.id, 'failed');
      }
    }
  }

  if (isRunning) {
    // Promote all pending nodes whose dependencies are met to running.
    let promoted = false;
    for (const node of baseNodes) {
      const status = statusById.get(node.id) ?? 'pending';
      if (status === 'completed' || status === 'failed' || status === 'running') {
        continue;
      }
      const depsReady = (node.dependencies ?? []).every((dep) => (statusById.get(dep) ?? 'pending') === 'completed');
      if (depsReady) {
        statusById.set(node.id, 'running');
        promoted = true;
      }
    }

    // Fallback: if nothing was promoted but session is running, mark first non-terminal node.
    if (!promoted && ![...statusById.values()].some((s) => s === 'running')) {
      const nonTerminal = baseNodes.find((node) => {
        const status = statusById.get(node.id) ?? 'pending';
        return status !== 'completed' && status !== 'failed';
      });
      const fallback = nonTerminal ?? baseNodes[0];
      if (fallback) {
        statusById.set(fallback.id, 'running');
      }
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
  const width = Math.max(900, levels.length * 360 + 240);
  const height = Math.max(520, maxPerLevel * 140 + 180);

  const nodes: GraphNodeView[] = [];
  for (const level of levels) {
    const group = levelGroups.get(level) ?? [];
    const stepY = height / (group.length + 1);
    group.forEach((node, index) => {
      const status = statusById.get(node.id) ?? normalizeTaskStatus(session.taskStatus[node.id]);
      nodes.push({ id: node.id, label: graphNodeLabel(node), prompt: node.prompt, x: 170 + level * 340, y: stepY * (index + 1), status, dependencies: node.dependencies });
    });
  }

  return { nodes, width, height };
}