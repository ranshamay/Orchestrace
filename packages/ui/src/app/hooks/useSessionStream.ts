import { useEffect, useRef } from 'react';
import { API_BASE, type AgentTodo, type ChatMessage, type WorkSession } from '../../lib/api';
import type { NodeTokenStream } from '../types';

type Params = {
  selectedSessionId: string;
  setSessions: (updater: WorkSession[] | ((current: WorkSession[]) => WorkSession[])) => void;
  setChatMessages: (updater: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
  setTodos: (updater: AgentTodo[] | ((current: AgentTodo[]) => AgentTodo[])) => void;
  setNodeTokenStreams: (updater: Record<string, NodeTokenStream> | ((current: Record<string, NodeTokenStream>) => Record<string, NodeTokenStream>)) => void;
};

/**
 * Connects to the SSE work stream for the selected session and applies
 * real-time incremental updates to sessions, chat messages, and todos.
 * Falls back gracefully — if SSE disconnects, the polling fallback still works.
 */
export function useSessionStream({ selectedSessionId, setSessions, setChatMessages, setTodos, setNodeTokenStreams }: Params) {
  const connectedIdRef = useRef<string>('');

  useEffect(() => {
    if (!selectedSessionId) {
      connectedIdRef.current = '';
      setNodeTokenStreams({});
      return;
    }

    const url = `${API_BASE}/work/stream?id=${encodeURIComponent(selectedSessionId)}`;
    const es = new EventSource(url);
    connectedIdRef.current = selectedSessionId;

    // Full session snapshot on connect or state change
    const handleReady = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          id: string;
          session: WorkSession;
          messages?: ChatMessage[];
          todos?: AgentTodo[];
        };
        if (data.session) {
          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === data.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = data.session;
              return next;
            }
            return [data.session, ...prev];
          });
        }
        if (data.messages) {
          setChatMessages(data.messages);
        }
        if (data.todos) {
          setTodos(data.todos);
        }
      } catch {
        // Ignore malformed data
      }
    };

    // Incremental session state updates
    const handleSessionUpdate = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; session: WorkSession };
        if (!data.session) return;
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === data.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data.session;
            return next;
          }
          return prev;
        });
      } catch {
        // Ignore malformed data
      }
    };

    // Todo updates
    const handleTodoUpdate = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; todos: AgentTodo[] };
        if (data.id === selectedSessionId && data.todos) {
          setTodos(data.todos);
        }
      } catch {
        // Ignore malformed data
      }
    };

    const handleToken = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          id: string;
          taskId?: string;
          phase?: 'planning' | 'implementation';
          delta?: string;
          time?: string;
        };

        if (data.id !== selectedSessionId || !data.taskId || !data.delta) {
          return;
        }

        const taskId = data.taskId;
        const phase: 'planning' | 'implementation' = data.phase === 'planning' ? 'planning' : 'implementation';
        const updatedAt = data.time ?? new Date().toISOString();

        setNodeTokenStreams((current) => {
          const previous = current[taskId];
          const nextText = `${previous?.text ?? ''}${data.delta}`;
          return {
            ...current,
            [taskId]: {
              phase,
              text: nextText.length > 420 ? nextText.slice(-420) : nextText,
              updatedAt,
            },
          };
        });
      } catch {
        // Ignore malformed token payloads.
      }
    };

    // Terminal events — update session status
    const handleEnd = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; status: string; llmStatus?: WorkSession['llmStatus'] };
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.id ? { ...s, status: data.status, llmStatus: data.llmStatus ?? s.llmStatus } : s,
          ),
        );
      } catch {
        // Ignore malformed data
      }
    };

    const handleError = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; error?: string; llmStatus?: WorkSession['llmStatus'] };
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.id
              ? { ...s, status: 'failed', error: data.error, llmStatus: data.llmStatus ?? s.llmStatus }
              : s,
          ),
        );
      } catch {
        // Ignore malformed data
      }
    };

    es.addEventListener('ready', handleReady);
    es.addEventListener('session-update', handleSessionUpdate);
    es.addEventListener('todo-update', handleTodoUpdate);
    es.addEventListener('token', handleToken);
    es.addEventListener('end', handleEnd);
    es.addEventListener('error', handleError);

    return () => {
      connectedIdRef.current = '';
      es.close();
    };
  }, [selectedSessionId, setSessions, setChatMessages, setNodeTokenStreams, setTodos]);
}
