import { describe, expect, it } from 'vitest';
import {
  enforceSafeShellDispatch,
  resolveTaskRoute,
  resolveTaskRouteForSource,
  stripRetryContinuationContext,
} from '../src/task-routing.js';

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

  it('strips retry continuation context before routing while preserving follow-up request', () => {
    const rawPrompt = [
      'Run echo hello world',
      '',
      'Retry continuation context from previous attempt:',
      '- Previous status: failed',
      '- Previous error: timeout',
      '- Todo snapshot: ...',
      '',
      'Follow-up request:',
      'try again',
    ].join('\n');

    const stripped = stripRetryContinuationContext(rawPrompt);
    expect(stripped).toContain('Run echo hello world');
    expect(stripped).toContain('Follow-up request:');
    expect(stripped).toContain('try again');
    expect(stripped).not.toContain('Retry continuation context from previous attempt:');
    expect(stripped).not.toContain('Previous status: failed');
  });

  it('keeps shell-command route for retry prompts once continuation context is stripped', () => {
    const rawPrompt = [
      'Run echo hello world',
      '',
      'Retry continuation context from previous attempt:',
      '- Previous status: completed',
      '- Agent graph snapshot: ...',
    ].join('\n');

    const route = resolveTaskRoute(stripRetryContinuationContext(rawPrompt));
    expect(route.result.category).toBe('shell_command');
    expect(route.result.strategy).toBe('direct_shell');
  });

  it('forces observer sessions to code_change route even when shell override is set', () => {
    const observerPrompt = [
      '[Observer Fix] Broken routing',
      '',
      'Category: architecture | Severity: critical',
      '',
      '## Task',
      'Route through coding agent pipeline.',
    ].join('\n');

    const route = resolveTaskRouteForSource(observerPrompt, 'observer', 'shell_command');
    expect(route.result.category).toBe('code_change');
    expect(route.result.strategy).toBe('full_planning_pipeline');
    expect(route.result.source).toBe('override');
  });

  it('demotes shell override for user prose prompt before execution', () => {
    const prompt = 'we want to make sure we will use git worktrees natively (probably by using git tool) each new session when impl starts';
    const resolvedRoute = resolveTaskRouteForSource(prompt, 'user', 'shell_command').result;
    expect(resolvedRoute.category).toBe('shell_command');

    const dispatch = enforceSafeShellDispatch(prompt, resolvedRoute);
    expect(dispatch.shell.ok).toBe(false);
    expect(dispatch.route.category).toBe('code_change');
    expect(dispatch.route.strategy).toBe('full_planning_pipeline');
  });

  it('keeps shell route for user command prompt under shell override', () => {
    const prompt = '$ pnpm test';
    const resolvedRoute = resolveTaskRouteForSource(prompt, 'user', 'shell_command').result;
    const dispatch = enforceSafeShellDispatch(prompt, resolvedRoute);

    expect(dispatch.route.category).toBe('shell_command');
    expect(dispatch.shell.ok).toBe(true);
    expect(dispatch.shell.command).toBe('pnpm test');
  });
});