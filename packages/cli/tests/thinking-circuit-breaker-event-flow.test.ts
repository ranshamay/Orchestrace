import { describe, expect, it } from 'vitest';
import type { DagEvent } from '@orchestrace/core';
import {
  THINKING_NO_TOOL_PROGRESS_NUDGE_MS,
  THINKING_CIRCUIT_BREAKER_NUDGE,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from '../src/thinking-circuit-breaker.js';

describe('thinking circuit breaker event-flow semantics', () => {
  it('emits one nudge after planning makes no tool progress for the configured duration, then resets after tool call', () => {
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
        if (updateThinkingCircuitBreaker(state, event, nowMs)) {
          emittedMessages.push(THINKING_CIRCUIT_BREAKER_NUDGE);
        }
      } else if (shouldResetThinkingCircuitBreakerOnEvent(event)) {
        resetThinkingCircuitBreaker(state, nowMs);
      }
    };

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS - 1);
    expect(emittedMessages).toHaveLength(0);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS);
    expect(emittedMessages).toEqual([THINKING_CIRCUIT_BREAKER_NUDGE]);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 2);
    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 3);
    expect(emittedMessages).toHaveLength(1);

    process(toolCall, THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 4);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 4 + THINKING_NO_TOOL_PROGRESS_NUDGE_MS - 1);
    expect(emittedMessages).toHaveLength(1);

    process(planningDelta(), THINKING_NO_TOOL_PROGRESS_NUDGE_MS * 5);
    expect(emittedMessages).toHaveLength(2);
  });
});