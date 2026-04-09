import { describe, expect, it } from 'vitest';
import { appendCleanupErrors, formatLifecyclePhaseFailure } from '../src/runner-lifecycle-diagnostics.js';

describe('runner lifecycle diagnostics', () => {
  it('formats failed phase prefix in error message', () => {
    expect(formatLifecyclePhaseFailure('DISPATCHING', 'provider unreachable'))
      .toBe('[phase=DISPATCHING] provider unreachable');
  });

  it('appends cleanup errors when present', () => {
    const result = appendCleanupErrors('[phase=EXECUTING] command failed', [
      { phase: 'SETTING_UP', actionLabel: 'remove-sigterm-listener', error: new Error('listener missing') },
      { phase: 'SETTING_UP', actionLabel: 'clear-heartbeat-interval', error: 'interval missing' },
    ]);

    expect(result).toContain('[phase=EXECUTING] command failed');
    expect(result).toContain('Cleanup errors:');
    expect(result).toContain('SETTING_UP:remove-sigterm-listener:listener missing');
    expect(result).toContain('SETTING_UP:clear-heartbeat-interval:interval missing');
  });

  it('keeps base message when no cleanup errors exist', () => {
    const base = '[phase=VALIDATING] prompt required';
    expect(appendCleanupErrors(base, [])).toBe(base);
  });
});