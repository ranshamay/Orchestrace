import {
  fetchSessions,
  fetchWorkAgent,
  retryWork,
  type AgentTodo,
  type ChatMessage,
  type WorkSession,
} from '../../lib/api';
import type { SessionLlmControls } from '../types';
import { normalizeSessionStatus } from '../utils/status';

type CommonStateSetters = {
  setErrorMessage: (message: string) => void;
  setSessions: (sessions: WorkSession[]) => void;
  setSelectedSessionId: (id: string) => void;
  setChatMessages: (messages: ChatMessage[]) => void;
  setTodos: (items: AgentTodo[]) => void;
};

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function refreshSessionsOnly(setters: Pick<CommonStateSetters, 'setSessions'>) {
  const sessionsState = await fetchSessions();
  setters.setSessions(sessionsState.sessions);
  return sessionsState.sessions;
}

export async function retryAndSyncSession(
  session: WorkSession,
  setters: CommonStateSetters,
) {
  if (normalizeSessionStatus(session.status) === 'running') return;

  const result = await retryWork(session.id);
  const sessionsState = await fetchSessions();
  setters.setSessions(sessionsState.sessions);
  setters.setSelectedSessionId(result.id);

  try {
    const agentState = await fetchWorkAgent(result.id);
    setters.setChatMessages(agentState.messages);
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