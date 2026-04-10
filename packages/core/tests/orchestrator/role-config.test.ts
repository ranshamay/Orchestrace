import { describe, expect, it } from 'vitest';
import { buildImplementationPrompt } from '../../src/orchestrator/role-config.js';

describe('role-config prompt policy', () => {
  it('uses sequential-first read/search guidance in implementation prompt', () => {
    const prompt = buildImplementationPrompt({
      node: {
        id: 'task-1',
        name: 'Task 1',
        type: 'code',
        prompt: 'Apply prompt policy updates.',
        dependencies: [],
      },
      depOutputs: new Map(),
      approvedPlan: 'Plan',
      attempt: 1,
      previousResponse: '',
      previousValidationError: '',
      effort: 'high',
    });

    expect(prompt).toContain('For reads/searches, issue individual sequential tool calls by default; only batch when unavoidable and cap concurrency to 2');
  });
});