import { describe, expect, it } from 'vitest';
import { buildCompletionFailureRetryHint } from '../../src/orchestrator/completion-retry-policy.js';

describe('completion retry policy', () => {
    it('tool_runtime hint prefers targeted reads and grep/find fallback over search_files loops', () => {
    const hint = buildCompletionFailureRetryHint({
      failureType: 'tool_runtime',
      errorMessage: 'search_files failed due to invalid regex',
    });

    expect(hint).toContain('Inspect prior tool-call errors, fix arguments/paths, and retry only needed targeted tools.');
        expect(hint).toContain('Prefer targeted read_file/read_files on known paths; if grep-like discovery is still needed, use scoped run_command/run_command_batch with grep/find instead of search_files loops.');
  });
});