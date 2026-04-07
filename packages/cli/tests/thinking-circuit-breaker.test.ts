import { describe, expect, it } from 'vitest';
import type { DagEvent } from '@orchestrace/core';
import {
  MAX_CONSECUTIVE_THINKING,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from '../src/thinking-circuit-breaker.js';

function planningDelta(): Extract<DagEvent, { type: 'task:stream-delta' }> {
  return {
    type: 'task:stream-delta',
    taskId: 'task',
    phase: 'planning',
    attempt: 1,
    delta: 'thinking',
  };
}

describe('thinking circuit breaker', () => {
  it('trips only when consecutive planning thinking cycles exceed threshold', () => {
    const state = createThinkingCircuitBreakerState();

    for (let i = 0; i < MAX_CONSECUTIVE_THINKING; i += 1) {
      expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(false);
    }

    expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(true);
  });

  it('does not re-emit within same streak after tripping (anti-spam latch)', () => {
    const state = createThinkingCircuitBreakerState();

    for (let i = 0; i <= MAX_CONSECUTIVE_THINKING; i += 1) {
      updateThinkingCircuitBreaker(state, planningDelta());
    }

    expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(false);
    expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(false);
  });

  it('resets after progress event and can trip again in a new streak', () => {
    const state = createThinkingCircuitBreakerState();

    for (let i = 0; i <= MAX_CONSECUTIVE_THINKING; i += 1) {
      updateThinkingCircuitBreaker(state, planningDelta());
    }

    expect(state.nudgeEmittedForCurrentStreak).toBe(true);

    resetThinkingCircuitBreaker(state);

    expect(state.consecutiveThinkingCycles).toBe(0);
    expect(state.nudgeEmittedForCurrentStreak).toBe(false);

    for (let i = 0; i < MAX_CONSECUTIVE_THINKING; i += 1) {
      expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(false);
    }
    expect(updateThinkingCircuitBreaker(state, planningDelta())).toBe(true);
  });

  it('ignores implementation stream deltas for breaker counting', () => {
    const state = createThinkingCircuitBreakerState();
    const implementationDelta: Extract<DagEvent, { type: 'task:stream-delta' }> = {
      ...planningDelta(),
      phase: 'implementation',
    };

    for (let i = 0; i < MAX_CONSECUTIVE_THINKING + 4; i += 1) {
      expect(updateThinkingCircuitBreaker(state, implementationDelta)).toBe(false);
    }

    expect(state.consecutiveThinkingCycles).toBe(0);
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
    expect(shouldResetThinkingCircuitBreakerOnEvent(completedEvent)).toBe(true);
  });
});