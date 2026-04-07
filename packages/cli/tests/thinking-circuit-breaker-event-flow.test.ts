import { describe, expect, it } from 'vitest';
import type { DagEvent } from '@orchestrace/core';
import {
  MAX_CONSECUTIVE_THINKING,
  THINKING_CIRCUIT_BREAKER_NUDGE,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from '../src/thinking-circuit-breaker.js';

describe('thinking circuit breaker event-flow semantics', () => {
  it('emits one nudge on 6th planning thinking cycle, then resets after tool call', () => {
    const state = createThinkingCircuitBreakerState();
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

    const process = (event: DagEvent): void => {
      if (isThinkingCycleEvent(event)) {
        if (updateThinkingCircuitBreaker(state, event, MAX_CONSECUTIVE_THINKING)) {
          emittedMessages.push(THINKING_CIRCUIT_BREAKER_NUDGE);
        }
      } else if (shouldResetThinkingCircuitBreakerOnEvent(event)) {
        resetThinkingCircuitBreaker(state);
      }
    };

    for (let i = 0; i < MAX_CONSECUTIVE_THINKING; i += 1) {
      process(planningDelta());
    }
    expect(emittedMessages).toHaveLength(0);

    process(planningDelta());
    expect(emittedMessages).toEqual([THINKING_CIRCUIT_BREAKER_NUDGE]);

    process(planningDelta());
    process(planningDelta());
    expect(emittedMessages).toHaveLength(1);

    process(toolCall);

    for (let i = 0; i < MAX_CONSECUTIVE_THINKING; i += 1) {
      process(planningDelta());
    }
    expect(emittedMessages).toHaveLength(1);

    process(planningDelta());
    expect(emittedMessages).toHaveLength(2);
  });
});