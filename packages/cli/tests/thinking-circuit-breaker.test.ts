import { describe, expect, it } from 'vitest';
import type { DagEvent } from '@orchestrace/core';
import {
  THINKING_NO_TOOL_PROGRESS_NUDGE_MS,
  THINKING_NO_TOOL_PROGRESS_ABORT_MS,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from '../src/thinking-circuit-breaker.js';

function planningDelta(attempt = 1): Extract<DagEvent, { type: 'task:stream-delta' }> {
  return {
    type: 'task:stream-delta',
    taskId: 'task',
    phase: 'planning',
    attempt,
    delta: 'thinking',
  };
}

describe('thinking circuit breaker', () => {
  it('nudges only after planning sees no tool progress for the threshold duration', () => {
    const state = createThinkingCircuitBreakerState(0);

    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS - 1)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS)).toBe('nudge');
  });

  it('does not re-emit nudge within same streak after tripping (anti-spam latch)', () => {
    const state = createThinkingCircuitBreakerState(0);

    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS)).toBe('nudge');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 2)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 3)).toBe('abort');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 4)).toBe('none');
  });

  it('resets after progress event and can nudge again in a new streak', () => {
    const state = createThinkingCircuitBreakerState(0);

    updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS);

    expect(state.nudgeEmittedForCurrentStreak).toBe(true);

    resetThinkingCircuitBreaker(state, 10_000);

    expect(state.lastToolProgressAtMs).toBe(10_000);
    expect(state.nudgeEmittedForCurrentStreak).toBe(false);
    expect(state.abortEmittedForCurrentStreak).toBe(false);

    expect(updateThinkingCircuitBreaker(state, planningDelta(), 10_000 + THINKING_NO_TOOL_PROGRESS_NUDGE_MS - 1)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), 10_000 + THINKING_NO_TOOL_PROGRESS_NUDGE_MS)).toBe('nudge');
  });

  it('aborts after prolonged no-tool planning time', () => {
    const state = createThinkingCircuitBreakerState(0);

    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS)).toBe('nudge');
    expect(updateThinkingCircuitBreaker(state, planningDelta(), THINKING_NO_TOOL_PROGRESS_ABORT_MS)).toBe('abort');
  });

  it('aborts when planning attempt advances repeatedly without tool progress', () => {
    const state = createThinkingCircuitBreakerState(0);

    expect(updateThinkingCircuitBreaker(state, planningDelta(1), 1_000)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(2), 2_000)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(3), 3_000)).toBe('none');
    expect(updateThinkingCircuitBreaker(state, planningDelta(4), 4_000)).toBe('abort');
  });

  it('ignores implementation stream deltas for breaker counting', () => {
    const state = createThinkingCircuitBreakerState(0);
    const implementationDelta: Extract<DagEvent, { type: 'task:stream-delta' }> = {
      ...planningDelta(),
      phase: 'implementation',
    };

    expect(updateThinkingCircuitBreaker(state, implementationDelta, THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 4)).toBe('none');

    expect(state.lastToolProgressAtMs).toBe(0);
  });

  it('has explicit qualifiers for thinking and reset events', () => {
    const thinkingEvent: DagEvent = planningDelta();
    const toolCallEvent: DagEvent = {
      type: 'task:tool-call',
      taskId: 'task',
      phase: 'planning',
      attempt: 1,
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'started',
      input: '{}',
    };
    const implementationAttempt: DagEvent = {
      type: 'task:implementation-attempt',
      taskId: 'task',
      attempt: 1,
      maxAttempts: 2,
    };
    const completedEvent: DagEvent = {
      type: 'task:completed',
      taskId: 'task',
      output: {
        taskId: 'task',
        status: 'success',
        response: 'done',
        filesChanged: [],
        validationResults: [],
        durationMs: 1,
        retries: 0,
      },
    };

    expect(isThinkingCycleEvent(thinkingEvent)).toBe(true);
    expect(shouldResetThinkingCircuitBreakerOnEvent(thinkingEvent)).toBe(false);
    expect(shouldResetThinkingCircuitBreakerOnEvent(toolCallEvent)).toBe(true);
    expect(shouldResetThinkingCircuitBreakerOnEvent(implementationAttempt)).toBe(true);
    expect(shouldResetThinkingCircuitBreakerOnEvent(completedEvent)).toBe(true);
  });
});