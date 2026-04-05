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
  const selectedSessionRunning = selectedSession ? normalizeSessionStatus(selectedSession.status) === 'running' : false;
  const selectedFailureType = selectedSessionRunning ? undefined : resolveSessionFailureType(selectedSession);
  const composerMode: ComposerMode = selectedSession
    ? (selectedSession.mode ?? fallbackComposerModeFromLlmState(selectedLlmStatus.state))
    : 'run';

  return {
    selectedLlmStatus,
    selectedFailureType,
    selectedSessionRunning,
    composerMode,
  };
}

function fallbackComposerModeFromLlmState(state: string): ComposerMode {
  const normalized = state.toLowerCase();

  if (
    normalized === 'planning'
    || normalized === 'awaiting-approval'
    || normalized === 'analyzing'
    || normalized === 'thinking'
    || normalized === 'queued'
  ) {
    return 'planning';
  }

  return 'implementation';
}

export function selectSidebarSummaries(sessions: WorkSession[]) {
  return {
    sessionStatusSummary: buildSessionStatusSummary(sessions),
    failureTypeSummary: buildFailureTypeSummary(sessions),
  };
}