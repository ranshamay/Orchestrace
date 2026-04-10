import type { ReplayToolCallRecord, TaskNode } from '../dag/types.js';
import type { TaskEffort } from './task-complexity.js';

export function buildPlanningContractError(
  toolCalls: ReplayToolCallRecord[],
    options?: {
    task?: TaskNode;
    quickStartMode?: boolean;
    quickStartMaxPreDelegationToolCalls?: number;
    planningMaxInvestigativeToolCalls?: number;
    taskEffort?: TaskEffort;
  },
): string | undefined {

    const effort = options?.taskEffort ?? 'high';
  const planningMaxInvestigativeToolCalls = Math.max(1, options?.planningMaxInvestigativeToolCalls ?? 12);

  // Low/trivial effort skips planning entirely, so never reaches this.

  // Medium/high: require todo_set + agent_graph_set as structural scaffolding.
  const requiredTools = ['todo_set', 'agent_graph_set'];
  const missing = requiredTools.filter((toolName) => !hasSuccessfulToolCall(toolCalls, toolName));

  const contractIssues: string[] = [];
  if (missing.length > 0) {
    contractIssues.push(`Missing successful coordination tool call(s): ${missing.join(', ')}.`);
  }

    const successfulInvestigativeToolCalls = countSuccessfulInvestigativeToolCalls(toolCalls);
  if (successfulInvestigativeToolCalls > planningMaxInvestigativeToolCalls) {
    contractIssues.push(
      `Planning exceeded investigative tool-call budget: ${successfulInvestigativeToolCalls}/${planningMaxInvestigativeToolCalls} successful investigative calls.`,
    );
    contractIssues.push(
      'After identifying core files/contract, emit todo_set + agent_graph_set and a concrete plan instead of additional exploratory reads/searches.',
    );
  }

  // Validate format of todo_set if it was called

  const todoSetResult = latestSuccessfulToolCall(toolCalls, 'todo_set');
  if (todoSetResult) {
    const todoValidation = validateWeightedListPayload(
      resolveToolCallInputForValidation(toolCalls, 'todo_set', todoSetResult),
      'items',
    );
    if (todoValidation.sum === undefined) {
      contractIssues.push('todo_set must include numeric weight for each item.');
    } else if (!isWeightTotalValid(todoValidation.sum)) {
      contractIssues.push(`todo_set item weights must sum to 100 (received ${formatWeightTotal(todoValidation.sum)}).`);
    }

    for (const issue of todoValidation.issues) {
      contractIssues.push(`todo_set ${issue}`);
    }
  }

  // Validate format of agent_graph_set if it was called
  const graphSetResult = latestSuccessfulToolCall(toolCalls, 'agent_graph_set');
  if (graphSetResult) {
    const graphValidation = validateWeightedListPayload(
      resolveToolCallInputForValidation(toolCalls, 'agent_graph_set', graphSetResult),
      'nodes',
    );
    if (graphValidation.sum === undefined) {
      contractIssues.push('agent_graph_set must include numeric weight for each node.');
    } else if (!isWeightTotalValid(graphValidation.sum)) {
      contractIssues.push(`agent_graph_set node weights must sum to 100 (received ${formatWeightTotal(graphValidation.sum)}).`);
    }

    for (const issue of graphValidation.issues) {
      contractIssues.push(`agent_graph_set ${issue}`);
    }
  }

  // Validate that sub-agent nodeIds map to graph nodes when both are used
  const hasSubAgentDelegation = hasSuccessfulToolCall(toolCalls, 'subagent_spawn')
    || hasSuccessfulToolCall(toolCalls, 'subagent_spawn_batch');
  const graphNodeIds = graphSetResult
    ? validateWeightedListPayload(
        resolveToolCallInputForValidation(toolCalls, 'agent_graph_set', graphSetResult),
        'nodes',
      ).ids
    : new Set<string>();
  if (graphNodeIds.size > 0 && hasSubAgentDelegation) {
    const delegatedNodeIds = collectSubAgentNodeIds(toolCalls);
    const mappedNodes = [...graphNodeIds].filter((nodeId) => delegatedNodeIds.has(nodeId));
    if (mappedNodes.length === 0) {
      contractIssues.push('subagent delegation must include nodeId values that map to agent_graph_set node ids.');
    }
  }

  if (contractIssues.length === 0) {
    return undefined;
  }

  return [
    'Planning contract not satisfied.',
    ...contractIssues,
    `Task effort: ${effort}. Planning must publish todo_set + agent_graph_set before implementation can begin. Sub-agent delegation is your choice - use it when it helps, skip it when the task is simple.`,
  ].join(' ');
}

export function createPlanningContractFailureSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/attempt\s+\d+/g, 'attempt')
    .trim();
}

const PLANNING_COORDINATION_TOOL_ALLOWLIST = new Set(['todo_set', 'agent_graph_set']);

function isInvestigativeTool(toolName: string): boolean {
  return !PLANNING_COORDINATION_TOOL_ALLOWLIST.has(toolName);
}

function countSuccessfulInvestigativeToolCalls(toolCalls: ReplayToolCallRecord[]): number {
  return toolCalls.reduce((count, call) => {
    if (call.status !== 'result' || call.isError) {
      return count;
    }
    if (!isInvestigativeTool(call.toolName)) {
      return count;
    }
    return count + 1;
  }, 0);
}

function hasSuccessfulToolCall(toolCalls: ReplayToolCallRecord[], toolName: string): boolean {
  return toolCalls.some((call) => call.status === 'result' && call.toolName === toolName && !call.isError);
}


function latestSuccessfulToolCall(
  toolCalls: ReplayToolCallRecord[],
  toolName: string,
): ReplayToolCallRecord | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.status === 'result' && call.toolName === toolName && !call.isError) {
      return call;
    }
  }

  return undefined;
}

function resolveToolCallInputForValidation(
  toolCalls: ReplayToolCallRecord[],
  toolName: string,
  successfulResultCall: ReplayToolCallRecord,
): string | undefined {
  if (successfulResultCall.input) {
    return successfulResultCall.input;
  }

  if (successfulResultCall.toolCallId) {
    for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
      const call = toolCalls[index];
      if (call.toolCallId !== successfulResultCall.toolCallId) {
        continue;
      }
      if (call.toolName !== toolName || call.status !== 'started') {
        continue;
      }
      if (call.input) {
        return call.input;
      }
    }
  }

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.toolName === toolName && call.status === 'started' && call.input) {
      return call.input;
    }
  }

  return undefined;
}

function validateWeightedListPayload(
  input: string | undefined,
  listKey: 'items' | 'nodes',
): {
  sum: number | undefined;
  issues: string[];
  ids: Set<string>;
} {
  const issues: string[] = [];
  const ids = new Set<string>();
  const dependenciesById = new Map<string, string[]>();
  let sum = 0;

  if (!input) {
    return { sum: undefined, issues, ids };
  }

  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const entries = Array.isArray(parsed[listKey]) ? parsed[listKey] : undefined;
    if (!entries || entries.length === 0) {
      issues.push('must include at least one entry.');
      return { sum: undefined, issues, ids };
    }

    for (let index = 0; index < entries.length; index += 1) {
      const rawEntry = entries[index];
      const prefix = `entry #${index + 1}`;
      if (!rawEntry || typeof rawEntry !== 'object') {
        issues.push(`${prefix} must be an object.`);
        continue;
      }

      const entry = rawEntry as Record<string, unknown>;
      const rawId = entry.id;
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id) {
        issues.push(`${prefix} must include a non-empty id.`);
      } else if (ids.has(id)) {
        issues.push(`${prefix} uses duplicate id "${id}".`);
      } else {
        ids.add(id);
      }

      const weight = entry.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        issues.push(`${prefix} must include a positive numeric weight.`);
      } else {
        sum += weight;
      }

      if (listKey === 'items') {
        const status = typeof entry.status === 'string' ? entry.status.trim() : '';
        if (status !== 'todo' && status !== 'in_progress' && status !== 'done') {
          issues.push(`${prefix} has invalid status "${status || '<missing>'}"; expected todo, in_progress, or done.`);
        }
      }

      const dependencyKey = listKey === 'items' ? 'dependsOn' : 'dependencies';
      const rawDeps = entry[dependencyKey];
      const deps = Array.isArray(rawDeps)
        ? rawDeps
          .map((value) => typeof value === 'string' ? value.trim() : '')
          .filter((value) => value.length > 0)
        : [];
      if (id) {
        dependenciesById.set(id, deps);
      }
    }

    for (const [id, deps] of dependenciesById.entries()) {
      for (const dep of deps) {
        if (dep === id) {
          issues.push(`entry "${id}" cannot depend on itself.`);
          continue;
        }
        if (!ids.has(dep)) {
          issues.push(`entry "${id}" references unknown dependency "${dep}".`);
        }
      }
    }

    if (hasDependencyCycle(dependenciesById)) {
      issues.push('contains a dependency cycle.');
    }

    return { sum, issues, ids };
  } catch {
    return {
      sum: undefined,
      ids,
      issues: ['payload is not valid JSON.'],
    };
  }
}

function hasDependencyCycle(dependenciesById: Map<string, string[]>): boolean {
  const stateById = new Map<string, 'visiting' | 'visited'>();

  const visit = (nodeId: string): boolean => {
    const current = stateById.get(nodeId);
    if (current === 'visiting') {
      return true;
    }
    if (current === 'visited') {
      return false;
    }

    stateById.set(nodeId, 'visiting');
    const deps = dependenciesById.get(nodeId) ?? [];
    for (const dep of deps) {
      if (!dependenciesById.has(dep)) {
        continue;
      }
      if (visit(dep)) {
        return true;
      }
    }
    stateById.set(nodeId, 'visited');
    return false;
  };

  for (const nodeId of dependenciesById.keys()) {
    if (visit(nodeId)) {
      return true;
    }
  }

  return false;
}

function collectSubAgentNodeIds(toolCalls: ReplayToolCallRecord[]): Set<string> {
  const nodeIds = new Set<string>();

  for (const call of toolCalls) {
    // Accept both 'started' and 'result' events since result events may lack input
    if (call.isError) {
      continue;
    }

    if (call.toolName === 'subagent_spawn') {
      const parsed = parseToolCallInput(call.input);
      const nodeId = parsed && typeof parsed.nodeId === 'string' ? parsed.nodeId.trim() : '';
      if (nodeId) {
        nodeIds.add(nodeId);
      }
      continue;
    }

    if (call.toolName === 'subagent_spawn_batch') {
      const parsed = parseToolCallInput(call.input);
      const agents = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
      for (const rawAgent of agents) {
        if (!rawAgent || typeof rawAgent !== 'object') {
          continue;
        }
        const agent = rawAgent as Record<string, unknown>;
        const nodeId = typeof agent.nodeId === 'string' ? agent.nodeId.trim() : '';
        if (nodeId) {
          nodeIds.add(nodeId);
        }
      }
    }
  }

  return nodeIds;
}

function parseToolCallInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isWeightTotalValid(value: number): boolean {
  return Math.abs(value - 100) <= 0.5;
}

function formatWeightTotal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
