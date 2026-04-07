import { describe, expect, it } from 'vitest';
import { coerceRouteForSessionSource, resolveTaskRoute } from '../src/task-routing.js';

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

  it('coerces observer shell routes into full planning pipeline', () => {
    const shellRoute = resolveTaskRoute('run git status').result;
    expect(shellRoute.category).toBe('shell_command');

    const coerced = coerceRouteForSessionSource(shellRoute, 'observer');
    expect(coerced.category).toBe('code_change');
    expect(coerced.strategy).toBe('full_planning_pipeline');
    expect(coerced.source).toBe('fallback');
  });
});