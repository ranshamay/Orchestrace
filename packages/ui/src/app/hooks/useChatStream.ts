import { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE, buildAuthedSseUrl, type AgentTodo, type SessionObserverFinding, type SessionObserverState, type WorkSession } from '../../lib/api';
import type {
  ChatMessage,
  ChatSessionPhase,
  ReasoningMessagePart,
  TextMessagePart,
  ToolCallMessagePart,
} from '../chat-types';
import type { NodeTokenStream } from '../types';
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
  setNodeTokenStreams: (updater: Record<string, NodeTokenStream> | ((current: Record<string, NodeTokenStream>) => Record<string, NodeTokenStream>)) => void;
};

export function useChatStream({ enabled = true, selectedSessionId, setSessions, setTodos, setObserverState, setNodeTokenStreams }: Params) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionMeta, setSessionMeta] = useState<ChatStreamSessionMeta>({ status: '', llmStatus: null });
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const connectedIdRef = useRef<string>('');
  const streamingMsgRef = useRef<string | null>(null);

  const resetState = useCallback(() => {
    setMessages([]);
    setSessionMeta({ status: '', llmStatus: null });
    setIsStreaming(false);
    setActiveMessageId(null);
    streamingMsgRef.current = null;
    setNodeTokenStreams({});
  }, [setNodeTokenStreams]);

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
        const msgs = data.messages ?? [];
        setMessages(msgs);
        setSessionMeta({ status: data.status, llmStatus: data.llmStatus });
        // Detect a buffered streaming message from the server (late-join snapshot)
        const streamingMsg = msgs.find((m) => m.status === 'streaming');
        if (streamingMsg) {
          streamingMsgRef.current = streamingMsg.id;
          setActiveMessageId(streamingMsg.id);
          setIsStreaming(true);
        } else {
          setIsStreaming(data.status === 'running');
        }
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
      | { type: 'todo-update'; sessionId: string; todos: AgentTodo[] }
      | { type: 'message-complete'; message: ChatMessage };

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
          if (event.role === 'assistant') {
            streamingMsgRef.current = event.messageId;
          }
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
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === event.messageId);
            if (existing) {
              return prev.map((m) => (m.id === event.messageId ? { ...m, parts: [...m.parts, part] } : m));
            }
            // Tool call arrived before any token — create the assistant message
            const msg: ChatMessage = {
              id: event.messageId,
              role: 'assistant',
              timestamp: new Date().toISOString(),
              status: 'streaming',
              parts: [part],
            };
            streamingMsgRef.current = event.messageId;
            setActiveMessageId(event.messageId);
            setIsStreaming(true);
            return [...prev, msg];
          });
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

        case 'message-complete': {
          const newMsg = event.message;
          if (streamingMsgRef.current && newMsg.role === 'assistant') {
            // Replace the transient streaming message with the final version
            setMessages((prev) => prev.map((m) => (m.id === streamingMsgRef.current ? newMsg : m)));
            streamingMsgRef.current = null;
            setActiveMessageId(null);
          } else {
            // New message (e.g. user chat follow-up, or assistant with no preceding tokens)
            setMessages((prev) => {
              const duplicate = prev.some((m) => m.role === newMsg.role && m.timestamp === newMsg.timestamp);
              if (duplicate) {
                return prev;
              }
              return [...prev, newMsg];
            });
          }
          break;
        }
      }
    }

    // ---- Legacy event handlers for live streaming -------------------------

    const finalizeStreaming = () => {
      if (streamingMsgRef.current) {
        const id = streamingMsgRef.current;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  status: 'complete' as const,
                  parts: m.parts.map((p) =>
                    (p.type === 'text' || p.type === 'reasoning') && 'isStreaming' in p
                      ? { ...p, isStreaming: false }
                      : p,
                  ),
                }
              : m,
          ),
        );
        streamingMsgRef.current = null;
        setActiveMessageId(null);
      }
      setIsStreaming(false);
    };

    const handleToken = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          id: string;
          messageId?: string;
          taskId?: string;
          phase?: string;
          delta?: string;
          isReasoning?: boolean;
          llmStatus?: WorkSession['llmStatus'];
          time?: string;
        };
        if (!data.delta) return;
        const isReasoning = data.isReasoning ?? false;

        if (!streamingMsgRef.current) {
          // Start a new streaming assistant message using the server-provided messageId
          const msgId = data.messageId || `stream-${Date.now()}`;
          streamingMsgRef.current = msgId;
          const partId = isReasoning ? `reasoning-${msgId}` : `text-${msgId}`;
          const part: ChatMessage['parts'][number] = isReasoning
            ? { type: 'reasoning', id: partId, text: data.delta, isStreaming: true }
            : { type: 'text', id: partId, text: data.delta, isStreaming: true };
          setMessages((prev) => [
            ...prev,
            {
              id: msgId,
              role: 'assistant',
              phase: (data.phase as ChatSessionPhase) ?? undefined,
              timestamp: data.time ?? new Date().toISOString(),
              status: 'streaming',
              parts: [part],
            },
          ]);
          setActiveMessageId(msgId);
          setIsStreaming(true);
        } else {
          // Append to existing streaming message
          const currentMsgId = streamingMsgRef.current;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== currentMsgId) return m;
              const lastPart = m.parts[m.parts.length - 1];
              if (isReasoning) {
                if (lastPart && lastPart.type === 'reasoning' && 'isStreaming' in lastPart && lastPart.isStreaming) {
                  return { ...m, parts: m.parts.map((p, i) => (i === m.parts.length - 1 && p.type === 'reasoning' ? { ...p, text: p.text + data.delta } : p)) };
                }
                // Start a new reasoning part
                const partId = `reasoning-${Date.now()}`;
                return { ...m, parts: [...m.parts, { type: 'reasoning' as const, id: partId, text: data.delta!, isStreaming: true }] };
              } else {
                if (lastPart && lastPart.type === 'text' && 'isStreaming' in lastPart && lastPart.isStreaming) {
                  return { ...m, parts: m.parts.map((p, i) => (i === m.parts.length - 1 && p.type === 'text' ? { ...p, text: p.text + data.delta } : p)) };
                }
                // Start a new text part (e.g. after reasoning ended)
                const partId = `text-${Date.now()}`;
                return { ...m, parts: [...m.parts, { type: 'text' as const, id: partId, text: data.delta!, isStreaming: true }] };
              }
            }),
          );
        }
        if (data.llmStatus) {
          setSessionMeta((prev) => ({ ...prev, llmStatus: data.llmStatus! }));
        }
        // Update nodeTokenStreams for graph node live text display
        if (data.taskId && data.delta) {
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
        }
      } catch {
        /* ignore */
      }
    };

    const handleEnd = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; status: string; llmStatus?: WorkSession['llmStatus'] };
        finalizeStreaming();
        setSessionMeta({ status: data.status, llmStatus: data.llmStatus ?? null });
        setSessions((prev) => {
          const existing = prev.find((s) => s.id === data.id);
          if (!existing) return prev;
          return upsertSessionWithActivityTransition(prev, { ...existing, status: data.status, llmStatus: data.llmStatus ?? existing.llmStatus });
        });
      } catch {
        /* ignore */
      }
    };

    const handleError = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; error?: string; llmStatus?: WorkSession['llmStatus'] };
        finalizeStreaming();
        setSessionMeta({ status: 'failed', llmStatus: data.llmStatus ?? null });
        setSessions((prev) => {
          const existing = prev.find((s) => s.id === data.id);
          if (!existing) return prev;
          return upsertSessionWithActivityTransition(prev, { ...existing, status: 'failed', error: data.error, llmStatus: data.llmStatus ?? existing.llmStatus });
        });
      } catch {
        /* ignore */
      }
    };

    const handleTodoUpdate = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; todos: AgentTodo[] };
        if (data.todos) setTodos(data.todos);
      } catch {
        /* ignore */
      }
    };

    const handleSessionUpdate = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; session: WorkSession };
        if (!data.session) return;
        setSessions((prev) => upsertSessionWithActivityTransition(prev, data.session));
        setSessionMeta({ status: data.session.status, llmStatus: data.session.llmStatus });
      } catch {
        /* ignore */
      }
    };

    const handleObserverStatus = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          id: string;
          observer: { status: string; findings: number; analyzedSteps: number; lastAnalyzedAt: string | null };
        };
        if (data.id === selectedSessionId) {
          setObserverState((prev) => ({
            status: data.observer.status as SessionObserverState['status'],
            findings: (prev as SessionObserverState | null)?.findings ?? [],
            analyzedSteps: data.observer.analyzedSteps,
            lastAnalyzedAt: data.observer.lastAnalyzedAt,
          }));
        }
      } catch {
        /* ignore */
      }
    };

    const handleObserverFinding = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id: string; finding: SessionObserverFinding };
        if (data.id === selectedSessionId && data.finding) {
          setObserverState((prev) => {
            const p = prev as SessionObserverState | null;
            if (!p) return { status: 'watching' as const, findings: [data.finding], analyzedSteps: 0, lastAnalyzedAt: null };
            if (p.findings.some((f) => f.id === data.finding.id)) return p;
            return { ...p, findings: [...p.findings, data.finding] };
          });
        }
      } catch {
        /* ignore */
      }
    };

    es.addEventListener('chat-ready', handleChatReady);
    es.addEventListener('chat', handleChat);
    es.addEventListener('token', handleToken);
    es.addEventListener('end', handleEnd);
    es.addEventListener('error', handleError);
    es.addEventListener('todo-update', handleTodoUpdate);
    es.addEventListener('session-update', handleSessionUpdate);
    es.addEventListener('observer-status', handleObserverStatus);
    es.addEventListener('observer-finding', handleObserverFinding);

    return () => {
      connectedIdRef.current = '';
      streamingMsgRef.current = null;
      resetState();
      setObserverState(null);
      es.close();
    };
  }, [enabled, selectedSessionId, setSessions, setTodos, setObserverState, resetState]);

  return { messages, sessionMeta, isStreaming, activeMessageId };
}
