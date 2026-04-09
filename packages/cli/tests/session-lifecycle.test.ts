import { describe, expect, it } from 'vitest';
import { SessionLifecycle, SessionLifecycleError } from '../src/session-lifecycle.js';

describe('SessionLifecycle', () => {
  it('enforces legal phase transitions', async () => {
    const lifecycle = new SessionLifecycle();

    await lifecycle.enterPhase('SETTING_UP');
    await lifecycle.enterPhase('DISPATCHING');
    await lifecycle.enterPhase('EXECUTING');
    await lifecycle.enterPhase('COMPLETING');
    await lifecycle.cleanup();
    await lifecycle.complete('COMPLETED');

    expect(lifecycle.diagnostics.enteredPhases).toEqual([
      'VALIDATING',
      'SETTING_UP',
      'DISPATCHING',
      'EXECUTING',
      'COMPLETING',
      'CLEANING_UP',
      'COMPLETED',
    ]);
  });

  it('rejects illegal transitions', async () => {
    const lifecycle = new SessionLifecycle();

    await expect(lifecycle.enterPhase('EXECUTING')).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(lifecycle.enterPhase('EXECUTING')).rejects.toMatchObject({
      type: 'illegal_transition',
      phase: 'VALIDATING',
    });
  });

  it('rejects precondition failures for target phase', async () => {
    const lifecycle = new SessionLifecycle();

    await expect(lifecycle.enterPhase('SETTING_UP', {
      precondition: () => false,
      preconditionMessage: 'prompt must be non-empty',
    })).rejects.toMatchObject({
      type: 'precondition_failed',
      phase: 'SETTING_UP',
      message: 'prompt must be non-empty',
    });
  });

  it('runs cleanup stack in reverse order and captures cleanup errors', async () => {
    const lifecycle = new SessionLifecycle();
    const steps: string[] = [];

    await lifecycle.enterPhase('SETTING_UP');
    lifecycle.registerCleanup('SETTING_UP', 'first', () => {
      steps.push('first');
    });
    lifecycle.registerCleanup('SETTING_UP', 'second', () => {
      steps.push('second');
      throw new Error('second failed');
    });
    lifecycle.registerCleanup('SETTING_UP', 'third', () => {
      steps.push('third');
    });

    await lifecycle.cleanup();
    await lifecycle.complete('FAILED');

    expect(steps).toEqual(['third', 'second', 'first']);
    expect(lifecycle.diagnostics.cleanupErrors).toHaveLength(1);
    expect(lifecycle.diagnostics.cleanupErrors[0]).toMatchObject({
      actionLabel: 'second',
      phase: 'SETTING_UP',
    });
    expect(lifecycle.diagnostics.currentPhase).toBe('FAILED');
  });
});