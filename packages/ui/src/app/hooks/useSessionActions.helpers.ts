import {
  fetchSessions,
  fetchWorkAgent,
  retryWork,
  type AgentTodo,
  type WorkSession,
} from '../../lib/api';
import type { SessionLlmControls } from '../types';
import { sortSessionsByActivityAndRecency } from '../utils/sessionSort';
import { normalizeSessionStatus } from '../utils/status';

type CommonStateSetters = {
  setErrorMessage: (message: string) => void;
  setSessions: (sessions: WorkSession[]) => void;
  setSelectedSessionId: (id: string) => void;
  setTodos: (items: AgentTodo[]) => void;
};

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function refreshSessionsOnly(setters: Pick<CommonStateSetters, 'setSessions'>) {
  const sessionsState = await fetchSessions();
  const sortedSessions = sortSessionsByActivityAndRecency(sessionsState.sessions);
  setters.setSessions(sortedSessions);
  return sortedSessions;
}

export async function retryAndSyncSession(
  session: WorkSession,
  setters: CommonStateSetters,
) {
  if (normalizeSessionStatus(session.status) === 'running') return;

  const result = await retryWork(session.id);
  const sessionsState = await fetchSessions();
  setters.setSessions(sortSessionsByActivityAndRecency(sessionsState.sessions));
  setters.setSelectedSessionId(result.id);

  try {
    const agentState = await fetchWorkAgent(result.id);
    setters.setTodos(agentState.todos);
  } catch {
    // Polling syncs shortly.
  }
}

export function removeSessionLlmControls(
  sessionId: string,
  setLlmControlsBySessionId: (
    updater:
      | Record<string, SessionLlmControls>
      | ((current: Record<string, SessionLlmControls>) => Record<string, SessionLlmControls>)
  ) => void,
) {
  setLlmControlsBySessionId((current) => {
    const next = { ...current };
    delete next[sessionId];
    return next;
  });
}