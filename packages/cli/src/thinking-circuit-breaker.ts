import type { DagEvent } from '@orchestrace/core';

export const THINKING_NO_TOOL_PROGRESS_NUDGE_MS = 30_000;
export const THINKING_NO_TOOL_PROGRESS_ABORT_MS = 90_000;
export const THINKING_STAGNANT_PLANNING_ATTEMPTS_ABORT_THRESHOLD = 3;

export const THINKING_CIRCUIT_BREAKER_NUDGE =
  'You appear to be stuck in planning. Please proceed with a concrete tool call or finalize your output.';
export const THINKING_CIRCUIT_BREAKER_ABORT =
  'Aborting run: planning appears stuck in a non-progress loop (no tool progress / no phase advancement).';

export type ThinkingCircuitBreakerAction = 'none' | 'nudge' | 'abort';

export type ThinkingCircuitBreakerState = {
  lastToolProgressAtMs: number;
  nudgeEmittedForCurrentStreak: boolean;
  abortEmittedForCurrentStreak: boolean;
  currentPlanningAttempt: number | null;
  stagnantPlanningAttemptTransitions: number;
};

export function createThinkingCircuitBreakerState(nowMs = Date.now()): ThinkingCircuitBreakerState {
  return {
    lastToolProgressAtMs: nowMs,
    nudgeEmittedForCurrentStreak: false,
    abortEmittedForCurrentStreak: false,
    currentPlanningAttempt: null,
    stagnantPlanningAttemptTransitions: 0,
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
  return event.type === 'task:tool-call'
    || event.type === 'task:implementation-attempt'
    || isTerminalDagEvent(event);
}

export function resetThinkingCircuitBreaker(state: ThinkingCircuitBreakerState, nowMs = Date.now()): void {
  state.lastToolProgressAtMs = nowMs;
  state.nudgeEmittedForCurrentStreak = false;
  state.abortEmittedForCurrentStreak = false;
  state.currentPlanningAttempt = null;
  state.stagnantPlanningAttemptTransitions = 0;
}

export function updateThinkingCircuitBreaker(
  state: ThinkingCircuitBreakerState,
  event: Extract<DagEvent, { type: 'task:stream-delta' }>,
  nowMs = Date.now(),
  noToolProgressNudgeMs = THINKING_NO_TOOL_PROGRESS_NUDGE_MS,
  noToolProgressAbortMs = THINKING_NO_TOOL_PROGRESS_ABORT_MS,
  stagnantPlanningAttemptsAbortThreshold = THINKING_STAGNANT_PLANNING_ATTEMPTS_ABORT_THRESHOLD,
): ThinkingCircuitBreakerAction {
  if (event.phase !== 'planning') {
    return 'none';
  }

  if (state.currentPlanningAttempt === null) {
    state.currentPlanningAttempt = event.attempt;
  } else if (event.attempt !== state.currentPlanningAttempt) {
    const attemptAdvanced = event.attempt > state.currentPlanningAttempt;
    state.currentPlanningAttempt = event.attempt;

    // Planning attempt advanced without intervening tool progress:
    // count this as another no-progress cycle and clear per-streak emits
    // so one bounded nudge+abort pair can happen again.
    if (attemptAdvanced) {
      state.stagnantPlanningAttemptTransitions += 1;
      state.nudgeEmittedForCurrentStreak = false;
      state.abortEmittedForCurrentStreak = false;
    }
  }

  const noToolElapsedMs = nowMs - state.lastToolProgressAtMs;

  const shouldAbortByTime = noToolElapsedMs >= noToolProgressAbortMs;
  const shouldAbortByAttemptStagnation = state.stagnantPlanningAttemptTransitions >= stagnantPlanningAttemptsAbortThreshold;
  if ((shouldAbortByTime || shouldAbortByAttemptStagnation) && !state.abortEmittedForCurrentStreak) {
    state.abortEmittedForCurrentStreak = true;
    return 'abort';
  }

  const shouldNudge = noToolElapsedMs >= noToolProgressNudgeMs;
  if (shouldNudge && !state.nudgeEmittedForCurrentStreak) {
    state.nudgeEmittedForCurrentStreak = true;
    return 'nudge';
  }

  return 'none';
}