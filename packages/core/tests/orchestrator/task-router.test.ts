import { describe, expect, it } from 'vitest';
import { classifyTaskPrompt, strategyForTaskRoute, type TaskRouteCategory } from '../../src/task-router.js';

describe('task-router', () => {
  it('classifies shell command prompts via directive prefix', () => {
    const result = classifyTaskPrompt('run pnpm test');
    expect(result.category).toBe('shell_command');
    expect(result.strategy).toBe('direct_shell');
    expect(result.source).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('classifies investigation prompts without code intent', () => {
    const result = classifyTaskPrompt('Investigate why CI is flaky and summarize findings');
    expect(result.category).toBe('investigation');
    expect(result.strategy).toBe('read_only_analysis');
    expect(result.source).toBe('heuristic');
  });

  it('classifies refactor prompts', () => {
    const result = classifyTaskPrompt('Refactor the session event parsing to reduce duplication');
    expect(result.category).toBe('refactor');
    expect(result.strategy).toBe('full_planning_pipeline');
    expect(result.source).toBe('heuristic');
  });

  it('defaults ambiguous prompts to safe code_change fallback', () => {
    const result = classifyTaskPrompt('Need help with this project soon');
    expect(result.category).toBe('code_change');
    expect(result.strategy).toBe('full_planning_pipeline');
    expect(result.source).toBe('fallback');
  });

  it('supports explicit route override', () => {
    const forced: TaskRouteCategory = 'investigation';
    const result = classifyTaskPrompt('implement feature x', { forceCategory: forced });
    expect(result.category).toBe('investigation');
    expect(result.strategy).toBe('read_only_analysis');
    expect(result.source).toBe('override');
    expect(result.confidence).toBe(1);
  });

  it('maps each category to a deterministic strategy', () => {
    expect(strategyForTaskRoute('shell_command')).toBe('direct_shell');
    expect(strategyForTaskRoute('investigation')).toBe('read_only_analysis');
    expect(strategyForTaskRoute('code_change')).toBe('full_planning_pipeline');
    expect(strategyForTaskRoute('refactor')).toBe('full_planning_pipeline');
  });

  it('does not classify multiline prompts as shell commands even with shell tokens', () => {
    const multiline = 'Add provider auth pre-flight check.\ngit worktree should be validated.\nbash scripts need updating.';
    const result = classifyTaskPrompt(multiline);
    expect(result.category).not.toBe('shell_command');
  });

  it('does not classify long prose prompts as shell commands even with shell tokens', () => {
    const longPrompt = 'Investigate why git authentication fails after 20 minutes of expensive session work including planning and sub-agent spawning and file reading before the provider returns a 401 error indicating the token expired';
    const result = classifyTaskPrompt(longPrompt);
    expect(result.category).not.toBe('shell_command');
  });

  it('does not classify natural language prompts that only mention git/worktree as shell commands', () => {
    const prompt = 'we want to make sure we will use git worktrees natively each new session when implementation starts';
    const result = classifyTaskPrompt(prompt);
    expect(result.category).not.toBe('shell_command');
    expect(result.strategy).toBe('full_planning_pipeline');
  });

  it('still classifies short single-line shell commands correctly', () => {
    expect(classifyTaskPrompt('git status').category).toBe('shell_command');
    expect(classifyTaskPrompt('run pnpm test').category).toBe('shell_command');
    expect(classifyTaskPrompt('$ npm install').category).toBe('shell_command');
  });
});