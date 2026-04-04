import { useEffect } from 'react';
import { fetchSessions, fetchWorkAgent, type AgentTodo, type ChatMessage, type WorkSession } from '../../lib/api';

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

        setSessions(sessionsState.sessions);

        const selectedExists = sessionsState.sessions.some((session) => session.id === selectedSessionId);
        if (!selectedExists) {
          const fallbackSessionId = sessionsState.sessions[0]?.id ?? '';
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
    const interval = setInterval(() => {
      void refreshSessionState();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSessionId, setChatMessages, setSelectedSessionId, setSessions, setTodos]);
}