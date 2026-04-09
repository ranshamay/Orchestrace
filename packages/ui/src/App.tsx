import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgentTodo,
  type ChatMessage,
  type SessionObserverState,
  updateUiPreferences,
} from './lib/api';
import type { ComposerImageAttachment, Tab } from './app/types';
import type { NodeTokenStream } from './app/types';
import { buildTimelineItems } from './app/utils/timelineItems';
import { useBootstrapData } from './app/hooks/useBootstrapData';
import { useProviderModels } from './app/hooks/useProviderModels';
import { useSessionPolling } from './app/hooks/useSessionPolling';
import { useSessionStream } from './app/hooks/useSessionStream';
import { useSessionsStatusStream } from './app/hooks/useSessionsStatusStream';
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
import { buildLlmModalProps } from './app/shell/props/buildLlmModalProps';
import { AppShell } from './app/shell/AppShell';
import type { SettingsSaveToastState } from './app/components/overlays/SettingsSaveToast';
import { readTabFromUrl, updateTabInUrl } from './app/utils/viewRoute';

export default function App() {
  const [activeTab, setActiveTabState] = useState<Tab>(() => readTabFromUrl());
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
  const [observerState, setObserverState] = useState<SessionObserverState | null>(null);
  const settingsSaveToastTimerRef = useRef<number | undefined>(undefined);
  const hydratedActiveTabPreferenceRef = useRef(false);
  const preferencesSyncInitializedRef = useRef(false);
  const preferenceSaveRequestIdRef = useRef(0);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const bootstrap = useBootstrapData();
  const {
    providers, providerStatuses, workspaces, activeWorkspaceId,
    sessions, setSessions, selectedSessionId, setSelectedSessionId,
    defaultLlmControls, setDefaultLlmControls,
    workPlanningProvider, setWorkPlanningProvider,
    workPlanningModel, setWorkPlanningModel,
    workProvider, setWorkProvider, workModel, setWorkModel,
    workWorkspaceId, setWorkWorkspaceId, autoApprove, setAutoApprove,
    planningNoToolGuardMode, setPlanningNoToolGuardMode,
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

  useSessionsStatusStream({ selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions });
  useSessionPolling({ selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions, setChatMessages, setTodos });
  useSessionStream({ selectedSessionId, setSessions, setChatMessages, setTodos, setNodeTokenStreams, setObserverState });
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
    if (!bootstrapComplete || hydratedActiveTabPreferenceRef.current) {
      return;
    }

    hydratedActiveTabPreferenceRef.current = true;
    if (readTabFromUrl() === 'graph' && activeTabPreference === 'settings') {
      const timer = window.setTimeout(() => {
        setActiveTabState('settings');
        updateTabInUrl('settings', 'replace');
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeTabPreference, bootstrapComplete]);

  const selectedSession = useMemo(() => selectCurrentSession(sessions, selectedSessionId), [sessions, selectedSessionId]);
  const { selectedLlmStatus, selectedFailureType, selectedSessionRunning, composerMode } = useMemo(
    () => selectSessionViewState(selectedSession),
    [selectedSession],
  );

  const { setLlmControlsBySessionId, updateActiveLlmControls } = useLlmControls({
    selectedSessionId, selectedSession, defaultLlmControls, setDefaultLlmControls,
    workPlanningProvider, setWorkPlanningProvider, workPlanningModel, setWorkPlanningModel,
    workProvider, setWorkProvider, workModel, setWorkModel, workWorkspaceId, setWorkWorkspaceId,
    planningNoToolGuardMode, setPlanningNoToolGuardMode,
    autoApprove, setAutoApprove,
    adaptiveConcurrency, setAdaptiveConcurrency,
    batchConcurrency, setBatchConcurrency,
    batchMinConcurrency, setBatchMinConcurrency,
  });

  const persistPhaseDefaults = useCallback((next: {
    planningProvider: string;
    planningModel: string;
    implementationProvider: string;
    implementationModel: string;
  }) => {
    void updateUiPreferences({
      defaultProvider: next.implementationProvider,
      defaultModel: next.implementationModel,
      defaultPlanningProvider: next.planningProvider,
      defaultPlanningModel: next.planningModel,
      defaultImplementationProvider: next.implementationProvider,
      defaultImplementationModel: next.implementationModel,
    }).catch(() => undefined);
  }, []);

  const setDefaultPlanningProvider = useCallback((nextProvider: string) => {
    const normalizedProvider = typeof nextProvider === 'string' ? nextProvider.trim() : '';
    const resetModel = normalizedProvider !== defaultLlmControls.planningProvider;
    const nextModel = resetModel ? '' : defaultLlmControls.planningModel;

    setDefaultLlmControls((current) => ({
      ...current,
      planningProvider: normalizedProvider,
      planningModel: resetModel ? '' : current.planningModel,
    }));

    setWorkPlanningProvider(normalizedProvider);
    setWorkPlanningModel(nextModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          planningProvider: normalizedProvider,
          planningModel: nextModel,
        };
      }
      return next;
    });
    persistPhaseDefaults({
      planningProvider: normalizedProvider,
      planningModel: nextModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
    });
    updateActiveLlmControls({ planningProvider: normalizedProvider, planningModel: nextModel });
  }, [defaultLlmControls.implementationModel, defaultLlmControls.implementationProvider, defaultLlmControls.planningModel, defaultLlmControls.planningProvider, persistPhaseDefaults, setDefaultLlmControls, setLlmControlsBySessionId, setWorkPlanningModel, setWorkPlanningProvider, updateActiveLlmControls]);

  const setDefaultPlanningModel = useCallback((nextModel: string) => {
    const normalizedModel = typeof nextModel === 'string' ? nextModel.trim() : '';
    setDefaultLlmControls((current) => ({ ...current, planningModel: normalizedModel }));
    setWorkPlanningModel(normalizedModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          planningModel: normalizedModel,
        };
      }
      return next;
    });
    persistPhaseDefaults({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: normalizedModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
    });
    updateActiveLlmControls({ planningModel: normalizedModel });
  }, [defaultLlmControls.implementationModel, defaultLlmControls.implementationProvider, defaultLlmControls.planningProvider, persistPhaseDefaults, setDefaultLlmControls, setLlmControlsBySessionId, setWorkPlanningModel, updateActiveLlmControls]);

  const setDefaultImplementationProvider = useCallback((nextProvider: string) => {
    const normalizedProvider = typeof nextProvider === 'string' ? nextProvider.trim() : '';
    const resetModel = normalizedProvider !== defaultLlmControls.implementationProvider;
    const nextModel = resetModel ? '' : defaultLlmControls.implementationModel;

    setDefaultLlmControls((current) => ({
      ...current,
      implementationProvider: normalizedProvider,
      implementationModel: resetModel ? '' : current.implementationModel,
    }));

    setWorkProvider(normalizedProvider);
    setWorkModel(nextModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          implementationProvider: normalizedProvider,
          implementationModel: nextModel,
        };
      }
      return next;
    });
    persistPhaseDefaults({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: normalizedProvider,
      implementationModel: nextModel,
    });
    updateActiveLlmControls({ implementationProvider: normalizedProvider, implementationModel: nextModel });
  }, [defaultLlmControls.implementationModel, defaultLlmControls.implementationProvider, defaultLlmControls.planningModel, defaultLlmControls.planningProvider, persistPhaseDefaults, setDefaultLlmControls, setLlmControlsBySessionId, setWorkModel, setWorkProvider, updateActiveLlmControls]);

  const setDefaultImplementationModel = useCallback((nextModel: string) => {
    const normalizedModel = typeof nextModel === 'string' ? nextModel.trim() : '';
    setDefaultLlmControls((current) => ({ ...current, implementationModel: normalizedModel }));
    setWorkModel(normalizedModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          implementationModel: normalizedModel,
        };
      }
      return next;
    });
    persistPhaseDefaults({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: normalizedModel,
    });
    updateActiveLlmControls({ implementationModel: normalizedModel });
  }, [defaultLlmControls.implementationProvider, defaultLlmControls.planningModel, defaultLlmControls.planningProvider, persistPhaseDefaults, setDefaultLlmControls, setLlmControlsBySessionId, setWorkModel, updateActiveLlmControls]);

  const handleStartNewSessionDraft = useCallback(() => {
    setActiveTab('graph');
    setSessionSelection('');
    updateActiveLlmControls({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
      planningNoToolGuardMode: defaultLlmControls.planningNoToolGuardMode,
    });
  }, [
    defaultLlmControls.implementationModel,
    defaultLlmControls.implementationProvider,
    defaultLlmControls.planningNoToolGuardMode,
    defaultLlmControls.planningModel,
    defaultLlmControls.planningProvider,
    setActiveTab,
    setSessionSelection,
    updateActiveLlmControls,
  ]);

  const modalTargetsPlanningPhase = composerMode === 'planning';
  const modalWorkProvider = modalTargetsPlanningPhase ? workPlanningProvider : workProvider;
  const modalWorkModel = modalTargetsPlanningPhase ? workPlanningModel : workModel;
  const modalSetWorkModel = modalTargetsPlanningPhase ? setWorkPlanningModel : setWorkModel;
  const modalPreferredModelForProvider = modalTargetsPlanningPhase
    ? (modalWorkProvider === defaultLlmControls.planningProvider ? defaultLlmControls.planningModel : '')
    : (modalWorkProvider === defaultLlmControls.implementationProvider ? defaultLlmControls.implementationModel : '');

  const {
    currentModels,
    missingModelWarning,
    confirmMissingModelSwitch,
    dismissMissingModelWarning,
  } = useProviderModels(
    modalWorkProvider,
    modalWorkModel,
    modalSetWorkModel,
    modalPreferredModelForProvider,
  );

  const timelineItems = useMemo(() => buildTimelineItems(selectedSession, chatMessages), [chatMessages, selectedSession]);
  const latestTimelineKey = timelineItems[timelineItems.length - 1]?.key ?? '';
  const timelineFollow = useTimelineFollow(latestTimelineKey, selectedSessionId);
  const toolsPanel = useToolsPanel(showToolsPanel, selectedSessionId, composerMode, selectedSession?.mode);

  const actions = useSessionActions({
    selectedSessionId, selectedSession, sessions, chatMessages, todos, composerText, composerImages,
    workWorkspaceId,
    workPlanningProvider,
    workPlanningModel,
    workProvider,
    workModel,
    planningNoToolGuardMode,
    autoApprove,
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

    const payload = {
      activeTab,
      observerShowFindings,
      planningNoToolGuardMode,
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
    onSettingsSaveStatus,
    observerShowFindings,
    planningNoToolGuardMode,
    setErrorMessage,
  ]);

  const setDefaultPlanningNoToolGuardMode = useCallback((next: 'enforce' | 'warn') => {
    const normalized = next === 'warn' ? 'warn' : 'enforce';
    setDefaultLlmControls((current) => ({ ...current, planningNoToolGuardMode: normalized }));
    setPlanningNoToolGuardMode(normalized);
    setLlmControlsBySessionId((current) => {
      const nextControls = { ...current };
      for (const sessionId of Object.keys(nextControls)) {
        const existing = nextControls[sessionId];
        nextControls[sessionId] = {
          ...existing,
          planningNoToolGuardMode: normalized,
        };
      }
      return nextControls;
    });
    updateActiveLlmControls({ planningNoToolGuardMode: normalized });
  }, [setDefaultLlmControls, setLlmControlsBySessionId, setPlanningNoToolGuardMode, updateActiveLlmControls]);

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

  const mainContentProps = {
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
    onAddTodo: () => actions.handleAddTodo(todoInput, setTodoInput),
    onToggleTodo: actions.handleToggleTodo,
    onOpenLlmControls: openLlmControlsModal,
    showToolsPanel,
    setShowToolsPanel,
    toolsMode: toolsPanel.toolsMode,
    availableTools: toolsPanel.availableTools,
    isToolsLoading: toolsPanel.isToolsLoading,
    toolsLoadError: toolsPanel.toolsLoadError,
    timelineContainerRef: timelineFollow.timelineContainerRef,
    followTimelineTail: timelineFollow.followTimelineTail,
    jumpToLatest: timelineFollow.jumpToLatest,
    onTimelineScroll: timelineFollow.handleTimelineScroll,
    timelineItems,
    composerMode,
    workspaces,
    workWorkspaceId,
    workPlanningProvider,
    workPlanningModel,
    workProvider,
    workModel,
    planningNoToolGuardMode,
    autoApprove,
    composerText,
    setComposerText,
    composerImages,
    removeComposerAttachment: (id: string) => {
      setComposerImages((current) => current.filter((item) => item.id !== id));
    },
    hasComposerContent: actions.hasComposerContent,
    onComposerPaste: actions.handleComposerPaste,
    onSendChat: actions.handleSendChat,
    onStop: actions.handleStop,
    providers,
    providerStatuses,
    activeWorkspaceId,
    defaultPlanningProvider: defaultLlmControls.planningProvider,
    defaultPlanningModel: defaultLlmControls.planningModel,
    defaultImplementationProvider: defaultLlmControls.implementationProvider,
    defaultImplementationModel: defaultLlmControls.implementationModel,
    defaultPlanningNoToolGuardMode: defaultLlmControls.planningNoToolGuardMode,
    onSetDefaultPlanningProvider: setDefaultPlanningProvider,
    onSetDefaultPlanningModel: setDefaultPlanningModel,
    onSetDefaultImplementationProvider: setDefaultImplementationProvider,
    onSetDefaultImplementationModel: setDefaultImplementationModel,
    onSetDefaultPlanningNoToolGuardMode: setDefaultPlanningNoToolGuardMode,
    observerShowFindings,
    onSetObserverShowFindings: setObserverShowFindings,
    onSettingsSaveStatus,
    nodeTokenStreams,
    observerState,
    copyTraceState: copyTraceState.sessionId === selectedSessionId ? copyTraceState.state : 'idle',
    onCopyTrace: () => {
      if (!selectedSessionId) return;
      void actions.handleCopyTraceSession(selectedSessionId).then((state) => {
        setCopyTraceState({ sessionId: selectedSessionId, state });
      });
    },
  };

  const llmModalProps = buildLlmModalProps({
    isOpen: isLlmControlsModalOpen,
    providers,
    providerStatuses,
    workspaces,
    currentModels,
    workWorkspaceId,
    workProvider: modalWorkProvider,
    workModel: modalWorkModel,
    autoApprove,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    closeLlmControlsModal,
    onChangeWorkspace: (workspaceId) => updateActiveLlmControls({ workspaceId }),
    onChangeProvider: (provider) => updateActiveLlmControls(modalTargetsPlanningPhase
      ? { planningProvider: provider, planningModel: '' }
      : { implementationProvider: provider, implementationModel: '' }),
    onChangeModel: (model) => updateActiveLlmControls(modalTargetsPlanningPhase
      ? { planningModel: model }
      : { implementationModel: model }),
    onChangeAutoApprove: (next) => updateActiveLlmControls({ autoApprove: next }),
    onChangeAdaptiveConcurrency: (next) => updateActiveLlmControls({ adaptiveConcurrency: next }),
    onChangeBatchConcurrency: (next) => updateActiveLlmControls({ batchConcurrency: next }),
    onChangeBatchMinConcurrency: (next) => updateActiveLlmControls({ batchMinConcurrency: next }),
  });

  const warningMessage = missingModelWarning
    ? `Model "${missingModelWarning.missingModel}" is not currently available for provider "${missingModelWarning.provider}".`
    : '';
  const warningActionLabel = missingModelWarning?.fallbackModel
    ? `Switch to "${missingModelWarning.fallbackModel}"`
    : '';

  return (
    <AppShell
      sessionSidebarProps={sessionSidebarProps}
      mainContentProps={mainContentProps}
      llmModalProps={llmModalProps}
      errorMessage={errorMessage}
      warningMessage={warningMessage}
      warningActionLabel={warningActionLabel}
      onWarningConfirm={confirmMissingModelSwitch}
      onWarningDismiss={dismissMissingModelWarning}
      settingsSaveToastState={settingsSaveToastState}
      settingsSaveToastMessage={settingsSaveToastMessage}
    />
  );
}