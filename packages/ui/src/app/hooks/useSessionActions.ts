import { useCallback, useRef } from 'react';
import { useSessionTodoActions } from './useSessionTodoActions';
import {
  cancelWork,
  deleteWork,
  fetchWorkAgent,
  sendChatMessage,
  startWork,
} from '../../lib/api';
import type { ComposerImageAttachment } from '../types';
import { copyTextToClipboard, readClipboardImage } from '../utils/clipboard';
import { composePrompt, composeRunPromptWithContext, toComposerContentParts } from '../utils/composer';
import { buildSessionTraceExport } from '../utils/traceExport';
import { refreshSessionsOnly, removeSessionLlmControls, retryAndSyncSession, toErrorMessage } from './useSessionActions.helpers';
import type { ComposerPasteEvent, SessionActionsParams } from './useSessionActions.types';

export function useSessionActions(params: SessionActionsParams) {
  const {
    selectedSessionId,
    selectedSession,
    sessions,
    chatMessages,
    todos,
    composerText,
    composerImages,
    workWorkspaceId,
    workPlanningProvider,
    workPlanningModel,
    workProvider,
    workModel,
    planningNoToolGuardMode,
    autoApprove,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    setErrorMessage,
    setSessions,
    setSelectedSessionId,
    setChatMessages,
    setTodos,
    setComposerText,
    setComposerImages,
    setLlmControlsBySessionId,
  } = params;
  const composerActionInFlightRef = useRef(false);

  const hasComposerContent = composerText.trim().length > 0 || composerImages.length > 0;

  const handleSendChat = useCallback(async () => {
    if (!hasComposerContent || composerActionInFlightRef.current) return;
    composerActionInFlightRef.current = true;
    setErrorMessage('');
    try {
      const payload = composePrompt(composerText, composerImages);
      const contentParts = toComposerContentParts(composerText, composerImages);

      if (!selectedSessionId) {
        if (!workProvider || !workModel || !workWorkspaceId) return;
        const runPrompt = selectedSession ? composeRunPromptWithContext(selectedSession.prompt, payload) : payload;
        const result = await startWork({
          workspaceId: workWorkspaceId,
          prompt: runPrompt,
          provider: workProvider,
          model: workModel,
          planningProvider: workPlanningProvider,
          planningModel: workPlanningModel,
          implementationProvider: workProvider,
          implementationModel: workModel,
          planningNoToolGuardMode,
          autoApprove,
          adaptiveConcurrency,
          batchConcurrency,
          batchMinConcurrency,
          promptParts: composerImages.length > 0 ? contentParts : undefined,
        });
        await refreshSessionsOnly({ setSessions });
        setSelectedSessionId(result.id);
      } else {
        await sendChatMessage(selectedSessionId, {
          message: payload,
          messageParts: composerImages.length > 0 ? contentParts : undefined,
        });
        await refreshSessionsOnly({ setSessions });
        const agentState = await fetchWorkAgent(selectedSessionId);
        setChatMessages(agentState.messages);
        setTodos(agentState.todos);
      }

      setComposerText('');
      setComposerImages([]);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      composerActionInFlightRef.current = false;
    }
  }, [
    autoApprove,
    batchConcurrency,
    batchMinConcurrency,
    composerImages,
    composerText,
    adaptiveConcurrency,
    hasComposerContent,
    selectedSession,
    selectedSessionId,
    setChatMessages,
    setComposerImages,
    setComposerText,
    setErrorMessage,
    setSessions,
    setSelectedSessionId,
    setTodos,
    planningNoToolGuardMode,
    workPlanningModel,
    workPlanningProvider,
    workModel,
    workProvider,
    workWorkspaceId,
  ]);

  const handleDelete = useCallback(async (targetSessionId?: string) => {
    const sessionId = targetSessionId ?? selectedSessionId;
    if (!sessionId) return;
    setErrorMessage('');
    try {
      await deleteWork(sessionId);
      removeSessionLlmControls(sessionId, setLlmControlsBySessionId);
      const nextSessions = await refreshSessionsOnly({ setSessions });
      const keepCurrent = nextSessions.some((session) => session.id === selectedSessionId);
      setSelectedSessionId(keepCurrent ? selectedSessionId : (nextSessions[0]?.id ?? ''));
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedSessionId, setErrorMessage, setLlmControlsBySessionId, setSelectedSessionId, setSessions]);

  const handleStop = useCallback(async () => {
    if (!selectedSessionId) return;
    setErrorMessage('');
    try {
      await cancelWork(selectedSessionId);
      await refreshSessionsOnly({ setSessions });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedSessionId, setErrorMessage, setSessions]);

  const handleRetry = useCallback(async () => {
    if (!selectedSession) return;
    setErrorMessage('');
    try {
      await retryAndSyncSession(selectedSession, { setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedSession, setChatMessages, setErrorMessage, setSelectedSessionId, setSessions, setTodos]);

  const handleRetrySession = useCallback(async (targetSessionId: string) => {
    const session = sessions.find((entry) => entry.id === targetSessionId);
    if (!session) return;
    setErrorMessage('');
    try {
      await retryAndSyncSession(session, { setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [sessions, setChatMessages, setErrorMessage, setSelectedSessionId, setSessions, setTodos]);

  const handleCopyTrace = useCallback(async () => {
    if (!selectedSession) return 'idle' as const;
    try {
      await copyTextToClipboard(buildSessionTraceExport(selectedSession, chatMessages, todos));
      return 'copied' as const;
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      return 'failed' as const;
    }
  }, [chatMessages, selectedSession, setErrorMessage, todos]);

  const handleCopyTraceSession = useCallback(async (targetSessionId: string) => {
    const session = sessions.find((entry) => entry.id === targetSessionId);
    if (!session) return 'idle' as const;
    try {
      let exportMessages = chatMessages;
      let exportTodos = todos;
      if (targetSessionId !== selectedSessionId) {
        const agentState = await fetchWorkAgent(targetSessionId);
        exportMessages = agentState.messages;
        exportTodos = agentState.todos;
      }
      await copyTextToClipboard(buildSessionTraceExport(session, exportMessages, exportTodos));
      return 'copied' as const;
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      return 'failed' as const;
    }
  }, [chatMessages, selectedSessionId, sessions, setErrorMessage, todos]);

  const handleComposerPaste = useCallback(async (event: ComposerPasteEvent) => {
    const items = Array.from(event.clipboardData?.items ?? []).filter((item) => item.type.startsWith('image/'));
    if (items.length === 0) return;
    event.preventDefault();
    setErrorMessage('');
    try {
      const attachments = (await Promise.all(items.map((item) => readClipboardImage(item)))).filter(
        (item): item is ComposerImageAttachment => item !== null,
      );
      if (attachments.length > 0) setComposerImages((current) => [...current, ...attachments]);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [setComposerImages, setErrorMessage]);

  const { handleAddTodo, handleToggleTodo } = useSessionTodoActions({
    selectedSessionId,
    setErrorMessage,
    setTodos,
  });

  return {
    hasComposerContent,
    handleSendChat,
    handleDelete,
    handleStop,
    handleRetry,
    handleRetrySession,
    handleCopyTrace,
    handleCopyTraceSession,
    handleComposerPaste,
    handleAddTodo,
    handleToggleTodo,
  };
}