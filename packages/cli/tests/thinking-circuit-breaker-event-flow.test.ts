import { describe, expect, it } from 'vitest';
import type { DagEvent } from '@orchestrace/core';
import {
  THINKING_NO_TOOL_PROGRESS_NUDGE_MS,
  THINKING_NO_TOOL_PROGRESS_ABORT_MS,
  THINKING_CIRCUIT_BREAKER_NUDGE,
  THINKING_CIRCUIT_BREAKER_ABORT,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from '../src/thinking-circuit-breaker.js';

describe('thinking circuit breaker event-flow semantics', () => {
  it('emits nudge then abort when planning makes no progress, then resets after tool call', () => {
    const state = createThinkingCircuitBreakerState(0);
    const emittedMessages: string[] = [];

    const planningDelta = (): DagEvent => ({
      type: 'task:stream-delta',
      taskId: 'task',
      phase: 'planning',
      attempt: 1,
      delta: 'Generating plan...',
    });

    const toolCall: DagEvent = {
      type: 'task:tool-call',
      taskId: 'task',
      phase: 'planning',
      attempt: 1,
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'started',
      input: '{}',
    };

    const process = (event: DagEvent, nowMs: number): void => {
      if (isThinkingCycleEvent(event)) {
        const action = updateThinkingCircuitBreaker(state, event, nowMs);
        if (action === 'nudge') {
          emittedMessages.push(THINKING_CIRCUIT_BREAKER_NUDGE);
        } else if (action === 'abort') {
          emittedMessages.push(THINKING_CIRCUIT_BREAKER_ABORT);
        }
      } else if (shouldResetThinkingCircuitBreakerOnEvent(event)) {
        resetThinkingCircuitBreaker(state, nowMs);
      }
    };

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS - 1);
    expect(emittedMessages).toHaveLength(0);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS);
    expect(emittedMessages).toEqual([THINKING_CIRCUIT_BREAKER_NUDGE]);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_ABORT_MS);
    expect(emittedMessages).toEqual([THINKING_CIRCUIT_BREAKER_NUDGE, THINKING_CIRCUIT_BREAKER_ABORT]);

    const resetAt = THINKING_NO_TOOL_PROGRESS_ABORT_MS + 1_000;
    process(toolCall, resetAt);

    process(planningDelta(), resetAt + THINKING_NO_TOOL_PROGRESS_NUDGE_MS);
    expect(emittedMessages).toEqual([
      THINKING_CIRCUIT_BREAKER_NUDGE,
      THINKING_CIRCUIT_BREAKER_ABORT,
      THINKING_CIRCUIT_BREAKER_NUDGE,
    ]);
  });

  it('aborts on repeated planning attempt advancement without any tool progress', () => {
    const state = createThinkingCircuitBreakerState(0);
    const emittedMessages: string[] = [];

    const process = (event: DagEvent, nowMs: number): void => {
      if (isThinkingCycleEvent(event)) {
        const action = updateThinkingCircuitBreaker(state, event, nowMs);
        if (action === 'abort') {
          emittedMessages.push(THINKING_CIRCUIT_BREAKER_ABORT);
        }
      }
    };

    process({ type: 'task:stream-delta', taskId: 'task', phase: 'planning', attempt: 1, delta: 'p1' }, 1_000);
    process({ type: 'task:stream-delta', taskId: 'task', phase: 'planning', attempt: 2, delta: 'p2' }, 2_000);
    process({ type: 'task:stream-delta', taskId: 'task', phase: 'planning', attempt: 3, delta: 'p3' }, 3_000);
    process({ type: 'task:stream-delta', taskId: 'task', phase: 'planning', attempt: 4, delta: 'p4' }, 4_000);

    expect(emittedMessages).toEqual([THINKING_CIRCUIT_BREAKER_ABORT]);
  });
});