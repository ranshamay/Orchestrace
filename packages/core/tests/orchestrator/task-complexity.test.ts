import { describe, expect, it } from 'vitest';
import {
  classifyTrivialTaskPrompt,
  classifyTaskEffort,
  extractSingleCommandFromPrompt,
  resolveTrivialTaskGateConfig,
} from '../../src/orchestrator/task-complexity.js';

describe('task complexity classifier', () => {
  it('classifies single shell command as trivial when enabled', () => {
    const result = classifyTrivialTaskPrompt('echo hello world', { enabled: true, maxPromptLength: 120 });
    expect(result.isTrivial).toBe(true);
    expect(result.reasons).toContain('single_shell_command');
  });

  it('classifies informational query as trivial when enabled', () => {
    const result = classifyTrivialTaskPrompt('what is the current node version?', { enabled: true, maxPromptLength: 120 });
    expect(result.isTrivial).toBe(true);
    expect(result.reasons).toContain('informational_query');
  });

  it('rejects prompts with file-edit markers', () => {
    const result = classifyTrivialTaskPrompt('edit src/index.ts and run tests', { enabled: true, maxPromptLength: 120 });
    expect(result.isTrivial).toBe(false);
    expect(result.reasons).toContain('contains_file_edit_markers');
  });

  it('rejects long prompts by threshold', () => {
    const result = classifyTrivialTaskPrompt('echo hello world'.repeat(20), { enabled: true, maxPromptLength: 40 });
    expect(result.isTrivial).toBe(false);
    expect(result.reasons).toContain('prompt_too_long');
  });

  it('returns disabled when gate is off', () => {
    const result = classifyTrivialTaskPrompt('echo hello world', { enabled: false, maxPromptLength: 120 });
    expect(result.isTrivial).toBe(false);
    expect(result.reasons).toContain('disabled');
  });

  it('extracts direct command from run prefix', () => {
    expect(extractSingleCommandFromPrompt('run echo hello world')).toBe('echo hello world');
  });

  it('extracts direct command from plain command prompt', () => {
    expect(extractSingleCommandFromPrompt('echo hello world')).toBe('echo hello world');
  });

  it('does not extract command for non-command prompt', () => {
    expect(extractSingleCommandFromPrompt('implement a tiny change')).toBeUndefined();
  });

  it('resolves config with explicit options precedence', () => {
    const resolved = resolveTrivialTaskGateConfig({ enabled: true, maxPromptLength: 42 });
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxPromptLength).toBe(42);
  });
});

describe('task effort classifier', () => {
  it('classifies shell commands as trivial effort', () => {
    expect(classifyTaskEffort('echo hello world').effort).toBe('trivial');
    expect(classifyTaskEffort('run echo hello world').effort).toBe('trivial');
    expect(classifyTaskEffort('git status').effort).toBe('trivial');
  });

  it('classifies informational queries as trivial effort', () => {
    expect(classifyTaskEffort('what is the current node version?').effort).toBe('trivial');
    expect(classifyTaskEffort('explain how the router works?').effort).toBe('trivial');
  });

  it('classifies short focused edits as low effort', () => {
    expect(classifyTaskEffort('fix the typo in runner.ts').effort).toBe('low');
    expect(classifyTaskEffort('update the default timeout value').effort).toBe('low');
    expect(classifyTaskEffort('add a console.log to the handler').effort).toBe('low');
  });

  it('classifies moderate multi-file work as medium effort', () => {
    const mediumPrompt = 'Update the task routing logic to support a new category and then update the CLI task-routing module to match. Also add validation for the new category type and also update the existing unit tests across multiple files in the test directory.';
    expect(classifyTaskEffort(mediumPrompt).effort).toBe('medium');
  });

  it('classifies large-scale work as high effort', () => {
    expect(classifyTaskEffort('refactor across all packages to use the new API').effort).toBe('high');
    expect(classifyTaskEffort('rewrite the entire orchestration pipeline from scratch').effort).toBe('high');
  });

  it('classifies long prompts with complexity indicators as high effort', () => {
    const longPrompt = 'Implement a comprehensive multi-package change that requires a full overhaul of the system. ' +
      'First update the core module, then modify the CLI, also update the provider layer, ' +
      'and finally ensure all tests pass across the monorepo. Open a pull request with all changes. ' +
      'This requires coordination between multiple teams and careful staging across the entire codebase. ' +
      'Additionally restructure the validation layer and migrate all existing consumers to the new API surface.';
    expect(classifyTaskEffort(longPrompt).effort).toBe('high');
  });

    it('returns reason for classification', () => {
    const result = classifyTaskEffort('echo hello');
    expect(result.reason).toBeTruthy();
    expect(result.promptLength).toBeGreaterThan(0);
  });

  it('classifies explicit planning prompts as medium effort', () => {
    const result = classifyTaskEffort('we want to perform sso via google, lets plan it, including authenticated apis');
    expect(result.effort).toBe('medium');
    expect(result.reason).toContain('planning');
  });
});