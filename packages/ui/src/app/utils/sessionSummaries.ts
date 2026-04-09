import type { WorkSession } from '../../lib/api';
import type { FailureType } from '../types';
import { resolveSessionFailureType } from './failure';
import { normalizeSessionStatus } from './status';

export type SessionStatusSummary = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
    pending: number;
  merged: number;
  unknown: number;

  overall: 'empty' | 'running' | 'attention' | 'idle';
};

export function buildSessionStatusSummary(sessions: WorkSession[]): SessionStatusSummary {
  const summary: SessionStatusSummary = {
    total: sessions.length,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    unknown: 0,
    overall: 'empty',
  };

  for (const session of sessions) {
    switch (normalizeSessionStatus(session.status)) {
      case 'running':
        summary.running += 1;
        break;
      case 'completed':
        summary.completed += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'cancelled':
        summary.cancelled += 1;
        break;
      case 'pending':
        summary.pending += 1;
        break;
      default:
        summary.unknown += 1;
        break;
    }
  }

  summary.overall = summary.total === 0
    ? 'empty'
    : summary.running > 0
      ? 'running'
      : summary.failed > 0
        ? 'attention'
        : 'idle';

  return summary;
}

export function buildFailureTypeSummary(sessions: WorkSession[]): Array<[FailureType, number]> {
  const counts: Record<FailureType, number> = {
    timeout: 0,
    auth: 0,
    rate_limit: 0,
    tool_schema: 0,
    tool_runtime: 0,
    validation: 0,
    empty_response: 0,
    unknown: 0,
  };

  for (const session of sessions) {
    const failureType = resolveSessionFailureType(session);
    if (failureType) {
      counts[failureType] += 1;
    }
  }

  return (Object.entries(counts) as Array<[FailureType, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
}