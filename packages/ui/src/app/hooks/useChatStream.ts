import { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE, buildAuthedSseUrl, type AgentTodo, type SessionObserverState, type WorkSession } from '../../lib/api';
import type {
  ChatMessage,
  ChatSessionPhase,
  ReasoningMessagePart,
  TextMessagePart,
  ToolCallMessagePart,
} from '../chat-types';
import { upsertSessionWithActivityTransition } from '../utils/sessionSort';

export interface ChatStreamSessionMeta {
  status: string;
  llmStatus: WorkSession['llmStatus'] | null;
}

type Params = {
  enabled?: boolean;
  selectedSessionId: string;
  setSessions: (updater: WorkSession[] | ((current: WorkSession[]) => WorkSession[])) => void;
  setTodos: (updater: AgentTodo[] | ((current: AgentTodo[]) => AgentTodo[])) => void;
  setObserverState: (updater: SessionObserverState | null | ((current: SessionObserverState | null) => SessionObserverState | null)) => void;
};

export function useChatStream({ enabled = true, selectedSessionId, setSessions, setTodos, setObserverState }: Params) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionMeta, setSessionMeta] = useState<ChatStreamSessionMeta>({ status: '', llmStatus: null });
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const connectedIdRef = useRef<string>('');

  const resetState = useCallback(() => {
    setMessages([]);
    setSessionMeta({ status: '', llmStatus: null });
    setIsStreaming(false);
    setActiveMessageId(null);
  }, []);

  useEffect(() => {
    if (!enabled || !selectedSessionId) {
      connectedIdRef.current = '';
      resetState();
      setObserverState(null);
      return;
    }

    const url = buildAuthedSseUrl(`${API_BASE}/work/stream?id=${encodeURIComponent(selectedSessionId)}&v=2`);
    const es = new EventSource(url);
    connectedIdRef.current = selectedSessionId;

    // Initial snapshot with legacy-converted ChatMessage[]
    const handleChatReady = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          id: string;
          messages: ChatMessage[];
          status: string;
          llmStatus: WorkSession['llmStatus'];
          todos?: AgentTodo[];
          observer?: SessionObserverState | null;
        };
        setMessages(data.messages ?? []);
        setSessionMeta({ status: data.status, llmStatus: data.llmStatus });
        setIsStreaming(data.status === 'running');
        if (data.todos) setTodos(data.todos);
        setObserverState(data.observer ?? null);
      } catch { /* ignore */ }
    };

    // All v2 events come through the 'chat' SSE event type
    const handleChat = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as ChatSseEvent;
        applyEvent(event);
      } catch { /* ignore */ }
    };

    type ChatSseEvent =
      | { type: 'message-start'; messageId: string; role: ChatMessage['role']; phase?: ChatSessionPhase; taskId?: string; agentId?: string; timestamp: string }
      | { type: 'message-end'; messageId: string }
      | { type: 'reasoning-start'; messageId: string; partId: string }
      | { type: 'reasoning-delta'; messageId: string; partId: string; delta: string }
      | { type: 'reasoning-end'; messageId: string; partId: string }
      | { type: 'text-start'; messageId: string; partId: string }
      | { type: 'text-delta'; messageId: string; partId: string; delta: string }
      | { type: 'text-end'; messageId: string; partId: string }
      | { type: 'tool-call-start'; messageId: string; partId: string; toolName: string; input: unknown; inputSummary: string }
      | { type: 'tool-call-end'; messageId: string; partId: string; status: 'success' | 'error'; output?: unknown; outputSummary?: string; error?: string }
      | { type: 'phase-transition'; phase: ChatSessionPhase; label: string; model?: string; provider?: string }
      | { type: 'context-snapshot'; messageId: string; partId: string; snapshotId: string; phase: string; model: string; textChars: number; imageCount: number }
      | { type: 'approval-request'; messageId: string; partId: string; planSummary: string }
      | { type: 'approval-response'; messageId: string; partId: string; status: 'approved' | 'rejected' }
      | { type: 'observer-finding'; messageId: string; partId: string; findingId: string; severity: string; title: string; detail?: string }
      | { type: 'error-part'; messageId: string; partId: string; message: string; detail?: string }
      | { type: 'status-update'; sessionId: string; status: string; llmStatus?: WorkSession['llmStatus'] }
      | { type: 'todo-update'; sessionId: string; todos: AgentTodo[] };

    function applyEvent(event: ChatSseEvent) {
      switch (event.type) {
        case 'message-start': {
          const msg: ChatMessage = {
            id: event.messageId,
            role: event.role,
            phase: event.phase,
            taskId: event.taskId,
            agentId: event.agentId,
            timestamp: event.timestamp,
            status: 'streaming',
            parts: [],
          };
          setMessages((prev) => [...prev, msg]);
          setActiveMessageId(event.messageId);
          setIsStreaming(true);
          break;
        }

        case 'message-end': {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    status: 'complete' as const,
                    parts: m.parts.map((p) =>
                      (p.type === 'reasoning' || p.type === 'text') && p.isStreaming
                        ? { ...p, isStreaming: false }
                        : p,
                    ),
                  }
                : m,
            ),
          );
          setActiveMessageId(null);
          break;
        }

        case 'reasoning-start': {
          const part: ReasoningMessagePart = { type: 'reasoning', id: event.partId, text: '', isStreaming: true };
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, parts: [...m.parts, part] } : m)),
          );
          break;
        }

        case 'reasoning-delta': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'reasoning' && p.id === event.partId
                    ? { ...p, text: p.text + event.delta }
                    : p,
                ),
              };
            }),
          );
          break;
        }

        case 'reasoning-end': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'reasoning' && p.id === event.partId
                    ? { ...p, isStreaming: false }
                    : p,
                ),
              };
            }),
          );
          break;
        }

        case 'text-start': {
          const part: TextMessagePart = { type: 'text', id: event.partId, text: '', isStreaming: true };
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, parts: [...m.parts, part] } : m)),
          );
          break;
        }

        case 'text-delta': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'text' && p.id === event.partId
                    ? { ...p, text: p.text + event.delta }
                    : p,
                ),
              };
            }),
          );
          break;
        }

        case 'text-end': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'text' && p.id === event.partId
                    ? { ...p, isStreaming: false }
                    : p,
                ),
              };
            }),
          );
          break;
        }

        case 'tool-call-start': {
          const part: ToolCallMessagePart = {
            type: 'tool-call',
            id: event.partId,
            toolName: event.toolName,
            input: event.input,
            inputSummary: event.inputSummary,
            status: 'calling',
            startTime: new Date().toISOString(),
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, parts: [...m.parts, part] } : m)),
          );
          break;
        }

        case 'tool-call-end': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'tool-call' && p.id === event.partId
                    ? {
                        ...p,
                        status: event.status,
                        output: event.output,
                        outputSummary: event.outputSummary,
                        endTime: new Date().toISOString(),
                        error: event.error,
                      }
                    : p,
                ),
              };
            }),
          );
          break;
        }

        case 'phase-transition': {
          // Insert as a standalone system message
          const msg: ChatMessage = {
            id: `pt-${Date.now()}`,
            role: 'system',
            phase: event.phase,
            timestamp: new Date().toISOString(),
            status: 'complete',
            parts: [{ type: 'phase-transition', phase: event.phase, label: event.label }],
            metadata: event.model ? { model: event.model, provider: event.provider } : undefined,
          };
          setMessages((prev) => [...prev, msg]);
          break;
        }

        case 'context-snapshot': {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    parts: [
                      ...m.parts,
                      {
                        type: 'context-snapshot' as const,
                        snapshotId: event.snapshotId,
                        phase: event.phase,
                        model: event.model,
                        textChars: event.textChars,
                        imageCount: event.imageCount,
                      },
                    ],
                  }
                : m,
            ),
          );
          break;
        }

        case 'approval-request': {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    parts: [
                      ...m.parts,
                      { type: 'approval-request' as const, planSummary: event.planSummary, status: 'pending' as const },
                    ],
                  }
                : m,
            ),
          );
          break;
        }

        case 'approval-response': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                parts: m.parts.map((p) =>
                  p.type === 'approval-request' ? { ...p, status: event.status } : p,
                ),
              };
            }),
          );
          break;
        }

        case 'observer-finding': {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    parts: [
                      ...m.parts,
                      {
                        type: 'observer-finding' as const,
                        findingId: event.findingId,
                        severity: event.severity,
                        title: event.title,
                        detail: event.detail,
                      },
                    ],
                  }
                : m,
            ),
          );
          break;
        }

        case 'error-part': {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    parts: [
                      ...m.parts,
                      { type: 'error' as const, message: event.message, detail: event.detail },
                    ],
                  }
                : m,
            ),
          );
          break;
        }

        case 'status-update': {
          setSessionMeta({ status: event.status, llmStatus: event.llmStatus ?? null });
          const terminal = event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled';
          if (terminal) {
            setIsStreaming(false);
            setActiveMessageId(null);
          }
          // Also update the session in the sessions list
          setSessions((prev) => {
            const existing = prev.find((s) => s.id === event.sessionId);
            if (!existing) return prev;
            return upsertSessionWithActivityTransition(prev, {
              ...existing,
              status: event.status,
              llmStatus: (event.llmStatus ?? existing.llmStatus) as WorkSession['llmStatus'],
            });
          });
          break;
        }

        case 'todo-update': {
          setTodos(event.todos);
          break;
        }
      }
    }

    es.addEventListener('chat-ready', handleChatReady);
    es.addEventListener('chat', handleChat);

    return () => {
      connectedIdRef.current = '';
      resetState();
      setObserverState(null);
      es.close();
    };
  }, [enabled, selectedSessionId, setSessions, setTodos, setObserverState, resetState]);

  return { messages, sessionMeta, isStreaming, activeMessageId };
}
