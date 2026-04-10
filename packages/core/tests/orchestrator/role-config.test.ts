import { describe, expect, it } from 'vitest';
import { buildImplementationPrompt } from '../../src/orchestrator/role-config.js';
import type { TaskNode } from '../../src/dag/types.js';

function makeTaskNode(): TaskNode {
  return {
    id: 'task-1',
    name: 'Task 1',
    type: 'code',
    prompt: 'Implement requested change',
    dependencies: [],
  };
}

describe('buildImplementationPrompt coordination guidance', () => {
  it('prefers planning state in context and only conditionally reads coordination tools', () => {
    const prompt = buildImplementationPrompt({
      node: makeTaskNode(),
      depOutputs: new Map(),
      attempt: 1,
      previousResponse: '',
      previousValidationError: '',
      effort: 'high',
      approvedPlan: 'Plan exists',
    });

    expect(prompt).toContain('Follow the todo list and execution graph from planning already present in context, and update progress via todo_update as you work.');
    expect(prompt).toContain('Call todo_get/agent_graph_get only when coordination state is missing, stale, or ambiguous.');
    expect(prompt).not.toContain('Follow the todo list from planning (read todo_get) and update via todo_update as you progress.');
    expect(prompt).not.toContain('Check agent_graph_get for the execution structure.');
  });
});