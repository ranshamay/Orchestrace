import { useEffect } from 'react';
import { fetchSessions, fetchWorkAgent, type AgentTodo, type ChatMessage, type WorkSession } from '../../lib/api';
import { sortSessionsByActivityAndRecency } from '../utils/sessionSort';

type Params = {
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  setSessions: (updater: WorkSession[] | ((current: WorkSession[]) => WorkSession[])) => void;
  setChatMessages: (updater: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
  setTodos: (updater: AgentTodo[] | ((current: AgentTodo[]) => AgentTodo[])) => void;
};

export function useSessionPolling({ selectedSessionId, setSelectedSessionId, setSessions, setChatMessages, setTodos }: Params) {
  useEffect(() => {
    if (!selectedSessionId) {
      setChatMessages([]);
      setTodos([]);
      return;
    }

    let cancelled = false;

    const refreshSessionState = async () => {
      try {
        const sessionsState = await fetchSessions();

        if (cancelled) {
          return;
        }

        const sortedSessions = sortSessionsByActivityAndRecency(sessionsState.sessions);
        setSessions(sortedSessions);

        const selectedExists = sortedSessions.some((session) => session.id === selectedSessionId);
        if (!selectedExists) {
          const fallbackSessionId = sortedSessions[0]?.id ?? '';
          if (fallbackSessionId !== selectedSessionId) {
            setSelectedSessionId(fallbackSessionId);
          }
          if (!fallbackSessionId) {
            setChatMessages([]);
            setTodos([]);
          }
          return;
        }

        const agentState = await fetchWorkAgent(selectedSessionId);
        if (cancelled) {
          return;
        }

        setChatMessages(agentState.messages);
        setTodos(agentState.todos);
      } catch {
        // Keep existing UI state if polling fails temporarily.
      }
    };

    void refreshSessionState();
    // Polling is a fallback for SSE — reduced frequency since real-time
    // updates arrive via EventSource in useSessionStream.
    const interval = setInterval(() => {
      void refreshSessionState();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSessionId, setChatMessages, setSelectedSessionId, setSessions, setTodos]);
}