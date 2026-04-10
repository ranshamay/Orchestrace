import { describe, expect, it } from 'vitest';
import { buildCompletionFailureRetryHint } from '../../src/orchestrator/completion-retry-policy.js';

describe('completion retry policy', () => {
  it('tool_runtime hint discourages broad shell reconnaissance fallback', () => {
    const hint = buildCompletionFailureRetryHint({
      failureType: 'tool_runtime',
      errorMessage: 'search_files failed due to invalid regex',
    });

    expect(hint).toContain('Inspect prior tool-call errors, fix arguments/paths, and retry only needed targeted tools.');
    expect(hint).toContain('Do not switch to broad shell reconnaissance (for example run_command/run_command_batch with rg) when existing context already covers the required files.');
  });
});