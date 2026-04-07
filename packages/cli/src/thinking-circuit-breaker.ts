import type { DagEvent } from '@orchestrace/core';

export const MAX_CONSECUTIVE_THINKING = 5;
export const THINKING_CIRCUIT_BREAKER_NUDGE =
  'You appear to be stuck in planning. Please proceed with a concrete tool call or finalize your output.';

export type ThinkingCircuitBreakerState = {
  consecutiveThinkingCycles: number;
  nudgeEmittedForCurrentStreak: boolean;
};

export function createThinkingCircuitBreakerState(): ThinkingCircuitBreakerState {
  return {
    consecutiveThinkingCycles: 0,
    nudgeEmittedForCurrentStreak: false,
  };
}

export function isThinkingCycleEvent(event: DagEvent): event is Extract<DagEvent, { type: 'task:stream-delta' }> {
  return event.type === 'task:stream-delta';
}

export function isTerminalDagEvent(event: DagEvent): boolean {
  return event.type === 'task:completed'
    || event.type === 'graph:completed'
    || event.type === 'task:failed'
    || event.type === 'graph:failed';
}

export function shouldResetThinkingCircuitBreakerOnEvent(event: DagEvent): boolean {
  return event.type === 'task:tool-call' || isTerminalDagEvent(event);
}

export function resetThinkingCircuitBreaker(state: ThinkingCircuitBreakerState): void {
  state.consecutiveThinkingCycles = 0;
  state.nudgeEmittedForCurrentStreak = false;
}

export function updateThinkingCircuitBreaker(
  state: ThinkingCircuitBreakerState,
  event: Extract<DagEvent, { type: 'task:stream-delta' }>,
  maxConsecutiveThinking = MAX_CONSECUTIVE_THINKING,
): boolean {
  if (event.phase !== 'planning') {
    return false;
  }

  state.consecutiveThinkingCycles += 1;
  const shouldTrip = state.consecutiveThinkingCycles > maxConsecutiveThinking;
  if (!shouldTrip || state.nudgeEmittedForCurrentStreak) {
    return false;
  }

  state.nudgeEmittedForCurrentStreak = true;
  return true;
}