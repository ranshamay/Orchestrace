import { describe, expect, it } from 'vitest';
import { buildPlanningContractError } from '../../src/orchestrator/planning-contract.js';
import type { ReplayToolCallRecord } from '../../src/dag/types.js';

function started(call: {
  id: string;
  toolName: string;
  input: string;
}): ReplayToolCallRecord {
  return {
    time: new Date().toISOString(),
    toolCallId: call.id,
    toolName: call.toolName,
    status: 'started',
    input: call.input,
  };
}

function result(call: {
  id: string;
  toolName: string;
  isError: boolean;
}): ReplayToolCallRecord {
  return {
    time: new Date().toISOString(),
    toolCallId: call.id,
    toolName: call.toolName,
    status: 'result',
    output: call.isError ? 'error' : 'ok',
    isError: call.isError,
  };
}

describe('buildPlanningContractError sub-agent delegation accounting', () => {
  const todoStarted = started({
    id: 'todo-1',
    toolName: 'todo_set',
    input: '{"items":[{"id":"p1","title":"Plan","status":"in_progress","weight":100}]}',
  });
  const todoResult = result({ id: 'todo-1', toolName: 'todo_set', isError: false });

  const graphStarted = started({
    id: 'graph-1',
    toolName: 'agent_graph_set',
    input: '{"nodes":[{"id":"n-good","prompt":"Inspect","weight":100}]}',
  });
  const graphResult = result({ id: 'graph-1', toolName: 'agent_graph_set', isError: false });

    it('does not treat failed subagent_spawn call as nodeId mapping evidence', () => {
    const calls: ReplayToolCallRecord[] = [
      todoStarted,
      todoResult,
      graphStarted,
      graphResult,
      started({
        id: 'sub-1',
        toolName: 'subagent_spawn',
        input: '{"nodeId":"n-good","prompt":"Investigate"}',
      }),
      result({ id: 'sub-1', toolName: 'subagent_spawn', isError: true }),
      started({
        id: 'sub-2',
        toolName: 'subagent_spawn',
        input: '{"nodeId":"n-wrong","prompt":"Investigate"}',
      }),
      result({ id: 'sub-2', toolName: 'subagent_spawn', isError: false }),
    ];

    const error = buildPlanningContractError(calls, { taskEffort: 'high' });
    expect(error).toContain('subagent delegation must include nodeId values that map to agent_graph_set node ids.');
  });


  it('counts only successful subagent_spawn nodeIds for graph mapping', () => {
    const calls: ReplayToolCallRecord[] = [
      todoStarted,
      todoResult,
      graphStarted,
      graphResult,
      started({
        id: 'sub-1',
        toolName: 'subagent_spawn',
        input: '{"nodeId":"n-good","prompt":"Investigate"}',
      }),
      result({ id: 'sub-1', toolName: 'subagent_spawn', isError: false }),
    ];

    const error = buildPlanningContractError(calls, { taskEffort: 'high' });
    expect(error).toBeUndefined();
  });

    it('does not treat failed subagent_spawn_batch call as nodeId mapping evidence', () => {
    const calls: ReplayToolCallRecord[] = [
      todoStarted,
      todoResult,
      graphStarted,
      graphResult,
      started({
        id: 'sub-batch-1',
        toolName: 'subagent_spawn_batch',
        input: '{"agents":[{"nodeId":"n-good","prompt":"Investigate"}]}',
      }),
      result({ id: 'sub-batch-1', toolName: 'subagent_spawn_batch', isError: true }),
      started({
        id: 'sub-batch-2',
        toolName: 'subagent_spawn_batch',
        input: '{"agents":[{"nodeId":"n-wrong","prompt":"Investigate"}]}',
      }),
      result({ id: 'sub-batch-2', toolName: 'subagent_spawn_batch', isError: false }),
    ];

    const error = buildPlanningContractError(calls, { taskEffort: 'high' });
    expect(error).toContain('subagent delegation must include nodeId values that map to agent_graph_set node ids.');
  });

});