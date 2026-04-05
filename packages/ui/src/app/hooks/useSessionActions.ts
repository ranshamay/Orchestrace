import { useCallback } from 'react';
import { useSessionTodoActions } from './useSessionTodoActions';
import {
  cancelWork,
  deleteWork,
  fetchWorkAgent,
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
    workProvider,
    workModel,
    autoApprove,
    useWorktree,
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

  const hasComposerContent = composerText.trim().length > 0 || composerImages.length > 0;

  const handleStartFromComposer = useCallback(async () => {
    if (!hasComposerContent || !workProvider || !workWorkspaceId) return;
    setErrorMessage('');
    try {
      const payload = composePrompt(composerText, composerImages);
      const runPrompt = selectedSession ? composeRunPromptWithContext(selectedSession.prompt, payload) : payload;
      const contentParts = toComposerContentParts(composerText, composerImages);
      const result = await startWork({
        workspaceId: workWorkspaceId,
        prompt: runPrompt,
        provider: workProvider,
        ...(workModel ? { model: workModel } : {}),
        autoApprove,
        useWorktree,
        adaptiveConcurrency,
        batchConcurrency,
        batchMinConcurrency,
        promptParts: composerImages.length > 0 ? contentParts : undefined,
      });
      await refreshSessionsOnly({ setSessions });
      setSelectedSessionId(result.id);
      setComposerText('');
      setComposerImages([]);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
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
    setComposerImages,
    setComposerText,
    setErrorMessage,
    setSelectedSessionId,
    setSessions,
    useWorktree,
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
    handleStartFromComposer,
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