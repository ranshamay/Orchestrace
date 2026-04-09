import type { WorkSession } from '../../lib/api';
import { normalizeSessionStatus } from './status';

function compareByRecencyDesc(a: WorkSession, b: WorkSession): number {
  const updatedDelta = b.updatedAt.localeCompare(a.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return b.createdAt.localeCompare(a.createdAt);
}

export function isActiveSession(session: WorkSession): boolean {
  const status = normalizeSessionStatus(session.status);
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

export function sortSessionsByActivityAndRecency(sessions: WorkSession[]): WorkSession[] {
  const active: WorkSession[] = [];
  const inactive: WorkSession[] = [];

  for (const session of sessions) {
    if (isActiveSession(session)) {
      active.push(session);
      continue;
    }
    inactive.push(session);
  }

  inactive.sort(compareByRecencyDesc);
  return [...active, ...inactive];
}

export function upsertSessionWithActivityTransition(
  current: WorkSession[],
  nextSession: WorkSession,
): WorkSession[] {
  const index = current.findIndex((session) => session.id === nextSession.id);
  const previousSession = index >= 0 ? current[index] : undefined;
  const next = index >= 0
    ? current.map((session, currentIndex) => (currentIndex === index ? nextSession : session))
    : [...current, nextSession];

  const becameActive = previousSession
    ? !isActiveSession(previousSession) && isActiveSession(nextSession)
    : isActiveSession(nextSession);

  if (!becameActive) {
    return sortSessionsByActivityAndRecency(next);
  }

  const withoutSession = next.filter((session) => session.id !== nextSession.id);
  return sortSessionsByActivityAndRecency([nextSession, ...withoutSession]);
}
