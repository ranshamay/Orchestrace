import type { WorkSession } from '../../lib/api';
import type { ComposerMode } from '../types';
import { resolveLlmStatus } from '../utils/llm';
import { resolveSessionFailureType } from '../utils/failure';
import { normalizeSessionStatus } from '../utils/status';
import { buildFailureTypeSummary, buildSessionStatusSummary } from '../utils/sessionSummaries';

export function selectCurrentSession(sessions: WorkSession[], selectedSessionId: string) {
  return sessions.find((session) => session.id === selectedSessionId);
}

export function selectSessionViewState(selectedSession?: WorkSession) {
  const selectedLlmStatus = resolveLlmStatus(selectedSession);
  const selectedFailureType = resolveSessionFailureType(selectedSession);
  const selectedSessionRunning = selectedSession ? normalizeSessionStatus(selectedSession.status) === 'running' : false;
  const composerMode: ComposerMode = selectedSession ? (selectedSession.mode ?? 'chat') : 'run';

  return {
    selectedLlmStatus,
    selectedFailureType,
    selectedSessionRunning,
    composerMode,
  };
}

export function selectSidebarSummaries(sessions: WorkSession[]) {
  return {
    sessionStatusSummary: buildSessionStatusSummary(sessions),
    failureTypeSummary: buildFailureTypeSummary(sessions),
  };
}