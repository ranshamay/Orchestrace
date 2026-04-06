import type { WorkSession } from '../../lib/api';
import type { FailureType } from '../types';
import { normalizeSessionStatus } from './status';

export function normalizeFailureType(raw?: string): FailureType | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (
    value === 'timeout'
    || value === 'auth'
    || value === 'rate_limit'
    || value === 'tool_schema'
    || value === 'tool_runtime'
    || value === 'validation'
    || value === 'empty_response'
    || value === 'unknown'
  ) {
    return value;
  }

  return undefined;
}

export function formatFailureTypeLabel(failureType?: string): string {
  const normalized = normalizeFailureType(failureType);
  if (!normalized) {
    return '';
  }

  return normalized.replace(/_/g, ' ');
}

export function failureTypeBadgeClass(failureType?: string, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  const normalized = normalizeFailureType(failureType);
  switch (normalized) {
    case 'timeout':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'auth':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'rate_limit':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'tool_schema':
    case 'tool_runtime':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300';
    case 'validation':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
    case 'empty_response':
      return 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
    case 'unknown':
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

export function resolveSessionFailureType(session?: WorkSession): FailureType | undefined {
  if (!session) {
    return undefined;
  }

  const sessionStatus = normalizeSessionStatus(session.status);
  const llmState = (session.llmStatus?.state ?? '').trim().toLowerCase();
  const currentlyFailed = sessionStatus === 'failed' || llmState === 'failed';

  // Keep failure badges tied to an active failed state only.
  // Historical failed events remain in the timeline, but should not mark resumed sessions.
  if (!currentlyFailed) {
    return undefined;
  }

  const fromStatus = normalizeFailureType(session.llmStatus?.failureType);
  if (fromStatus) {
    return fromStatus;
  }

  const fromOutput = normalizeFailureType(session.output?.failureType);
  if (fromOutput) {
    return fromOutput;
  }

  const lastFailedEvent = [...session.events]
    .reverse()
    .find((event) => event.type === 'task:failed' && normalizeFailureType(event.failureType));

  return normalizeFailureType(lastFailedEvent?.failureType);
}