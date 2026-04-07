import { describe, expect, it } from 'vitest';
import {
  classifyTrivialTaskPrompt,
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