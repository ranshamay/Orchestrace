import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgentTodo,
  type ChatMessage,
  updateUiPreferences,
} from './lib/api';
import type { ComposerImageAttachment, Tab } from './app/types';
import type { NodeTokenStream } from './app/types';
import { buildTimelineItems } from './app/utils/timelineItems';
import { useBootstrapData } from './app/hooks/useBootstrapData';
import { useProviderModels } from './app/hooks/useProviderModels';
import { useSessionPolling } from './app/hooks/useSessionPolling';
import { useSessionStream } from './app/hooks/useSessionStream';
import { useRunUrlSync } from './app/hooks/useRunUrlSync';
import { useTimelineFollow } from './app/hooks/useTimelineFollow';
import { useToolsPanel } from './app/hooks/useToolsPanel';
import { useLlmControls } from './app/hooks/useLlmControls';
import { useSessionActions } from './app/hooks/useSessionActions';
import { useThemePreference } from './app/hooks/useThemePreference';
import { useSessionSelectionController } from './app/hooks/useSessionSelectionController';
import { useLlmControlsModalState } from './app/hooks/useLlmControlsModalState';
import { selectCurrentSession, selectSessionViewState, selectSidebarSummaries } from './app/selectors/sessionViewSelectors';
import { buildSessionSidebarProps } from './app/shell/props/buildSessionSidebarProps';
import { buildMainContentProps } from './app/shell/props/buildMainContentProps';
import { buildLlmModalProps } from './app/shell/props/buildLlmModalProps';
import { AppShell } from './app/shell/AppShell';
import type { SettingsSaveToastState } from './app/components/overlays/SettingsSaveToast';
import { readTabFromUrl, updateTabInUrl } from './app/utils/viewRoute';

export default function App() {
  const [activeTab, setActiveTabState] = useState<Tab>(() => readTabFromUrl());
  const [hydratedActiveTabPreference, setHydratedActiveTabPreference] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [composerText, setComposerText] = useState('');
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [todoInput, setTodoInput] = useState('');
  const [copyTraceState, setCopyTraceState] = useState<{ sessionId: string; state: 'idle' | 'copied' | 'failed' }>({ sessionId: '', state: 'idle' });
  const [settingsSaveToastState, setSettingsSaveToastState] = useState<SettingsSaveToastState>('idle');
  const [settingsSaveToastMessage, setSettingsSaveToastMessage] = useState('');
  const [nodeTokenStreams, setNodeTokenStreams] = useState<Record<string, NodeTokenStream>>({});
  const settingsSaveToastTimerRef = useRef<number | undefined>(undefined);
  const preferencesSyncInitializedRef = useRef(false);
  const preferenceSaveRequestIdRef = useRef(0);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const bootstrap = useBootstrapData();
  const {
    providers, providerStatuses, workspaces, activeWorkspaceId,
    sessions, setSessions, selectedSessionId, setSelectedSessionId,
    defaultLlmControls, setDefaultLlmControls,
    workProvider, setWorkProvider, workModel, setWorkModel,
    workWorkspaceId, setWorkWorkspaceId, autoApprove, setAutoApprove,
    errorMessage, setErrorMessage,
    adaptiveConcurrency, setAdaptiveConcurrency,
    bootstrapComplete,
    batchConcurrency, setBatchConcurrency,
    batchMinConcurrency, setBatchMinConcurrency,
    activeTabPreference,
    observerShowFindings, setObserverShowFindings,
  } = bootstrap;

  const { theme, setTheme, isDark } = useThemePreference();
  const { setSessionSelection } = useSessionSelectionController({ selectedSessionId, sessions, setSelectedSessionId });
  const { isLlmControlsModalOpen, openLlmControlsModal, closeLlmControlsModal } = useLlmControlsModalState();

  const onSettingsSaveStatus = useCallback((state: Exclude<SettingsSaveToastState, 'idle'>, message: string) => {
    if (settingsSaveToastTimerRef.current !== undefined) {
      window.clearTimeout(settingsSaveToastTimerRef.current);
      settingsSaveToastTimerRef.current = undefined;
    }

    setSettingsSaveToastState(state);
    setSettingsSaveToastMessage(message);

    if (state === 'saved' || state === 'error') {
      const timeoutMs = state === 'saved' ? 1600 : 4500;
      settingsSaveToastTimerRef.current = window.setTimeout(() => {
        setSettingsSaveToastState('idle');
        setSettingsSaveToastMessage('');
        settingsSaveToastTimerRef.current = undefined;
      }, timeoutMs);
    }
  }, []);

  const setActiveTab = useCallback((tab: Tab) => {
    setActiveTabState(tab);
    updateTabInUrl(tab, 'push');
  }, []);

  useSessionPolling({ selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions, setChatMessages, setTodos });
  useSessionStream({ selectedSessionId, setSessions, setChatMessages, setTodos, setNodeTokenStreams });
  useRunUrlSync(selectedSessionId, setSessionSelection);

  useEffect(() => {
    updateTabInUrl(activeTab, 'replace');
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePopState = () => {
      setActiveTabState(readTabFromUrl());
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (settingsSaveToastTimerRef.current !== undefined) {
        window.clearTimeout(settingsSaveToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!bootstrapComplete || hydratedActiveTabPreference) {
      return;
    }

    setHydratedActiveTabPreference(true);
    if (readTabFromUrl() === 'graph' && activeTabPreference === 'settings') {
      setActiveTabState('settings');
      updateTabInUrl('settings', 'replace');
    }
  }, [activeTabPreference, bootstrapComplete, hydratedActiveTabPreference]);

  const selectedSession = useMemo(() => selectCurrentSession(sessions, selectedSessionId), [sessions, selectedSessionId]);
  const { selectedLlmStatus, selectedFailureType, selectedSessionRunning, composerMode } = useMemo(
    () => selectSessionViewState(selectedSession),
    [selectedSession],
  );

  const { setLlmControlsBySessionId, updateActiveLlmControls } = useLlmControls({
    selectedSessionId, selectedSession, defaultLlmControls, setDefaultLlmControls,
    workProvider, setWorkProvider, workModel, setWorkModel, workWorkspaceId, setWorkWorkspaceId,
    autoApprove, setAutoApprove,
    adaptiveConcurrency, setAdaptiveConcurrency,
    batchConcurrency, setBatchConcurrency,
    batchMinConcurrency, setBatchMinConcurrency,
  });

  const setDefaultProvider = useCallback((nextProvider: string) => {
    const normalizedProvider = typeof nextProvider === 'string' ? nextProvider.trim() : '';
    const resetModel = normalizedProvider !== defaultLlmControls.provider;
    const nextModel = resetModel ? '' : defaultLlmControls.model;

    setDefaultLlmControls((current) => ({
      ...current,
      provider: normalizedProvider,
      model: resetModel ? '' : current.model,
    }));

    if (!selectedSessionId) {
      updateActiveLlmControls({ provider: normalizedProvider, model: nextModel });
    }
  }, [defaultLlmControls.model, defaultLlmControls.provider, selectedSessionId, setDefaultLlmControls, updateActiveLlmControls]);

  const setDefaultModel = useCallback((nextModel: string) => {
    const normalizedModel = typeof nextModel === 'string' ? nextModel.trim() : '';
    setDefaultLlmControls((current) => ({ ...current, model: normalizedModel }));

    if (!selectedSessionId) {
      updateActiveLlmControls({ model: normalizedModel });
    }
  }, [selectedSessionId, setDefaultLlmControls, updateActiveLlmControls]);

  const handleStartNewSessionDraft = useCallback(() => {
    setActiveTab('graph');
    setSessionSelection('');
    updateActiveLlmControls({
      provider: defaultLlmControls.provider,
      model: defaultLlmControls.model,
    });
  }, [defaultLlmControls.model, defaultLlmControls.provider, setActiveTab, setSessionSelection, updateActiveLlmControls]);

  const { currentModels } = useProviderModels(workProvider, workModel, setWorkModel);

  const timelineItems = useMemo(() => buildTimelineItems(selectedSession, chatMessages), [chatMessages, selectedSession]);
  const latestTimelineKey = timelineItems[timelineItems.length - 1]?.key ?? '';
  const timelineFollow = useTimelineFollow(latestTimelineKey, selectedSessionId);
  const toolsPanel = useToolsPanel(showToolsPanel, selectedSessionId, composerMode, selectedSession?.mode);

  const actions = useSessionActions({
    selectedSessionId, selectedSession, sessions, chatMessages, todos, composerText, composerImages,
    workWorkspaceId, workProvider, workModel, autoApprove,
    adaptiveConcurrency, batchConcurrency, batchMinConcurrency,
    setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos,
    setComposerText, setComposerImages, setLlmControlsBySessionId,
  });

  const { sessionStatusSummary, failureTypeSummary } = useMemo(() => selectSidebarSummaries(sessions), [sessions]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!preferencesSyncInitializedRef.current) {
      preferencesSyncInitializedRef.current = true;
      return;
    }

    const requestId = ++preferenceSaveRequestIdRef.current;
    onSettingsSaveStatus('saving', 'Saving settings...');

    const payload = {
      activeTab,
      observerShowFindings,
      defaultProvider: defaultLlmControls.provider,
      defaultModel: defaultLlmControls.model,
      adaptiveConcurrency,
      batchConcurrency,
      batchMinConcurrency,
    };

    preferenceSaveQueueRef.current = preferenceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await updateUiPreferences(payload);
        if (requestId !== preferenceSaveRequestIdRef.current) {
          return;
        }
        onSettingsSaveStatus('saved', 'Settings saved.');
      })
      .catch((error) => {
        if (requestId === preferenceSaveRequestIdRef.current) {
          onSettingsSaveStatus('error', 'Failed to save settings.');
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
        throw error;
      });
  }, [
    activeTab,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    bootstrapComplete,
    defaultLlmControls.model,
    defaultLlmControls.provider,
    onSettingsSaveStatus,
    observerShowFindings,
    setErrorMessage,
  ]);

  const sessionSidebarProps = buildSessionSidebarProps({
    activeTab,
    setActiveTab,
    theme,
    setTheme,
    sessions,
    selectedSessionId,
    setSessionSelection,
    onStartNewSessionDraft: handleStartNewSessionDraft,
    setCopyTraceState,
    actions,
    copyTraceState,
    sessionStatusSummary,
    failureTypeSummary,
  });

  const mainContentProps = buildMainContentProps({
    activeTab,
    selectedSessionId,
    selectedSession,
    selectedSessionRunning,
    selectedFailureType: selectedFailureType ?? null,
    selectedLlmStatus,
    isDark,
    todos,
    todoInput,
    setTodoInput,
    actions,
    openLlmControlsModal,
    showToolsPanel,
    setShowToolsPanel,
    toolsPanel,
    timelineFollow: {
      timelineContainerRef: timelineFollow.timelineContainerRef,
      followTimelineTail: timelineFollow.followTimelineTail,
      jumpToLatest: timelineFollow.jumpToLatest,
      onTimelineScroll: timelineFollow.handleTimelineScroll,
    },
    timelineItems,
    composerMode,
    workspaces,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    composerText,
    setComposerText,
    composerImages,
    setComposerImages,
    providers,
    providerStatuses,
    activeWorkspaceId,
    defaultProvider: defaultLlmControls.provider,
    defaultModel: defaultLlmControls.model,
    onSetDefaultProvider: setDefaultProvider,
    onSetDefaultModel: setDefaultModel,
    observerShowFindings,
    onSetObserverShowFindings: setObserverShowFindings,
    onSettingsSaveStatus,
    nodeTokenStreams,
    copyTraceState: copyTraceState.sessionId === selectedSessionId ? copyTraceState.state : 'idle',
    onCopyTrace: () => {
      if (!selectedSessionId) return;
      void actions.handleCopyTraceSession(selectedSessionId).then((state) => {
        setCopyTraceState({ sessionId: selectedSessionId, state });
      });
    },
  });

  const llmModalProps = buildLlmModalProps({
    isOpen: isLlmControlsModalOpen,
    providers,
    providerStatuses,
    workspaces,
    currentModels,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    closeLlmControlsModal,
    onChangeWorkspace: (workspaceId) => updateActiveLlmControls({ workspaceId }),
    onChangeProvider: (provider) => updateActiveLlmControls({ provider, model: '' }),
    onChangeModel: (model) => updateActiveLlmControls({ model }),
    onChangeAutoApprove: (next) => updateActiveLlmControls({ autoApprove: next }),
    onChangeAdaptiveConcurrency: (next) => updateActiveLlmControls({ adaptiveConcurrency: next }),
    onChangeBatchConcurrency: (next) => updateActiveLlmControls({ batchConcurrency: next }),
    onChangeBatchMinConcurrency: (next) => updateActiveLlmControls({ batchMinConcurrency: next }),
  });

  return (
    <AppShell
      sessionSidebarProps={sessionSidebarProps}
      mainContentProps={mainContentProps}
      llmModalProps={llmModalProps}
      errorMessage={errorMessage}
      settingsSaveToastState={settingsSaveToastState}
      settingsSaveToastMessage={settingsSaveToastMessage}
    />
  );
}