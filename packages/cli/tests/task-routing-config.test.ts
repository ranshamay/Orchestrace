import { describe, expect, it } from 'vitest';
import { extractShellCommand, parseTaskRouteOverride, resolveTaskRoute, validateShellCommandPrompt } from '../src/task-routing.js';

describe('task routing config', () => {
  it('parses valid override values', () => {
    expect(parseTaskRouteOverride('shell_command')).toBe('shell_command');
    expect(parseTaskRouteOverride(' investigation ')).toBe('investigation');
    expect(parseTaskRouteOverride('invalid')).toBeUndefined();
  });

  it('resolves shell command route with direct strategy', () => {
    const route = resolveTaskRoute('run pnpm -w test');
    expect(route.result.category).toBe('shell_command');
    expect(route.result.strategy).toBe('direct_shell');
  });

  it('disables validation for investigation route', () => {
    const route = resolveTaskRoute('investigate flaky tests and summarize root causes');
    expect(route.result.category).toBe('investigation');
    expect(route.validationEnabled).toBe(false);
  });

  it('maps refactor route to refactor task type', () => {
    const route = resolveTaskRoute('refactor graph builder internals');
    expect(route.result.category).toBe('refactor');
    expect(route.nodeType).toBe('refactor');
  });

  it('extracts shell command from prompt directives', () => {
    expect(extractShellCommand('run pnpm typecheck')).toBe('pnpm typecheck');
    expect(extractShellCommand('$ git status')).toBe('git status');
    expect(extractShellCommand('git status')).toBe('git status');
    expect(extractShellCommand('   ')).toBeUndefined();
  });

  it('rejects multiline prompts in extractShellCommand', () => {
    const multiline = '[Observer Fix] Auth check\nCategory: architecture\ngit worktree issue';
    expect(extractShellCommand(multiline)).toBeUndefined();
  });

  it('rejects long prose prompts in extractShellCommand', () => {
    const longPrompt = 'Add a provider authentication pre-flight check at session startup before any planning or tool execution begins. In the session runner initialization make a lightweight API call to validate credentials.';
    expect(extractShellCommand(longPrompt)).toBeUndefined();
  });

  it('treats prose mentioning git/worktrees as non-shell work', () => {
    const prompt = 'we want to make sure we will use git worktrees natively (probably by using git tool) each new session when impl starts, make sure we use native approach and not abstraction of worktree';
    const route = resolveTaskRoute(prompt);
    expect(route.result.category).toBe('code_change');
    expect(route.result.strategy).toBe('full_planning_pipeline');
    expect(extractShellCommand(prompt)).toBeUndefined();
  });
});
