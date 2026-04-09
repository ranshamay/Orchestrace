import type { ReplayFailureType } from '../dag/types.js';

export type PlanningNoToolGuardMode = 'enforce' | 'warn';

export const PLANNING_NO_TOOL_PROGRESS_TIMEOUT_MS = 5 * 60_000;
export const PLANNING_NO_TOOL_PROGRESS_CHECK_INTERVAL_MS = 1_000;
export const PLANNING_NO_TOOL_PROGRESS_NUDGE =
  'Planning did not make tool progress. Use a concrete tool call to advance the plan.';
export const PLANNING_NO_PROGRESS_ABORT_SENTINEL = '__orchestrace_planning_no_progress__';
export const PLANNING_NO_TOOL_INITIAL_CUTOFF_MS = 20_000;
export const PLANNING_PRE_FIRST_TOOL_TOKEN_NUDGE_BUDGET = 2_000;
export const PLANNING_PRE_FIRST_TOOL_TOKEN_ABORT_BUDGET = 3_000;

const DEFAULT_PLANNING_NO_TOOL_GUARD_MODE: PlanningNoToolGuardMode = 'enforce';

export function createPlanningNoProgressAbortError(): Error {
  const error = new Error(PLANNING_NO_PROGRESS_ABORT_SENTINEL);
  (error as Error & { failureType?: ReplayFailureType }).failureType = 'empty_response';
  return error;
}

export function normalizePlanningNoToolGuardMode(value: unknown): PlanningNoToolGuardMode {
  return value === 'warn' ? 'warn' : DEFAULT_PLANNING_NO_TOOL_GUARD_MODE;
}

export function isPlanningNoProgressAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === PLANNING_NO_PROGRESS_ABORT_SENTINEL;
}
