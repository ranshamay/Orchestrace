import type { WorkSession } from '../../lib/api';
import { normalizeSessionStatus } from './status';

function isActiveSession(session: WorkSession): boolean {
  const status = normalizeSessionStatus(session.status);
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

export function sortSessionsByActivityAndRecency(sessions: WorkSession[]): WorkSession[] {
  return [...sessions].sort((a, b) => {
    const activeDelta = Number(isActiveSession(b)) - Number(isActiveSession(a));
    if (activeDelta !== 0) {
      return activeDelta;
    }

    const updatedDelta = b.updatedAt.localeCompare(a.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return b.createdAt.localeCompare(a.createdAt);
  });
}