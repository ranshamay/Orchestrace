import type { DagEvent } from '@orchestrace/core';

export const THINKING_NO_TOOL_PROGRESS_NUDGE_MS = 30_000;
export const THINKING_CIRCUIT_BREAKER_NUDGE =
  'You appear to be stuck in planning. Please proceed with a concrete tool call or finalize your output.';

export type ThinkingCircuitBreakerState = {
  lastToolProgressAtMs: number;
  nudgeEmittedForCurrentStreak: boolean;
};

export function createThinkingCircuitBreakerState(nowMs = Date.now()): ThinkingCircuitBreakerState {
  return {
    lastToolProgressAtMs: nowMs,
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

export function resetThinkingCircuitBreaker(state: ThinkingCircuitBreakerState, nowMs = Date.now()): void {
  state.lastToolProgressAtMs = nowMs;
  state.nudgeEmittedForCurrentStreak = false;
}

export function updateThinkingCircuitBreaker(
  state: ThinkingCircuitBreakerState,
  event: Extract<DagEvent, { type: 'task:stream-delta' }>,
  nowMs = Date.now(),
  noToolProgressNudgeMs = THINKING_NO_TOOL_PROGRESS_NUDGE_MS,
): boolean {
  if (event.phase !== 'planning') {
    return false;
  }

  const shouldTrip = nowMs - state.lastToolProgressAtMs >= noToolProgressNudgeMs;
  if (!shouldTrip || state.nudgeEmittedForCurrentStreak) {
    return false;
  }

  state.nudgeEmittedForCurrentStreak = true;
  return true;
}