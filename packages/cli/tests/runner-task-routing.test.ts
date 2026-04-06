import { describe, expect, it } from 'vitest';
import { resolveTaskRoute } from '../src/task-routing.js';

describe('runner task routing parity', () => {
  it('defaults ambiguous prompts to safe full pipeline category', () => {
    const route = resolveTaskRoute('help me with this later');
    expect(route.result.category).toBe('code_change');
    expect(route.result.strategy).toBe('full_planning_pipeline');
  });

  it('supports route override parity for runner', () => {
    const route = resolveTaskRoute('implement feature x', 'investigation');
    expect(route.result.category).toBe('investigation');
    expect(route.result.source).toBe('override');
    expect(route.validationEnabled).toBe(false);
  });
});