import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUTH_EXPIRED_EVENT,
  PROVIDER_REAUTH_REQUIRED_EVENT,
  clearStoredAuthToken,
  type AppAuthStatusResponse,
  fetchAppAuthConfig,
  fetchAppAuthStatus,
  logoutAppAuth,
  setStoredAuthToken,
  type AgentModels,
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
import { selectCurrentSession, selectSessionViewState } from './app/selectors/sessionViewSelectors';
import { buildLlmModalProps } from './app/shell/props/buildLlmModalProps';
import { AppShell } from './app/shell/AppShell';
import { LoginGate } from './app/components/auth/LoginGate';
import type { SettingsSaveToastState } from './app/components/overlays/SettingsSaveToast';
import { readTabFromUrl, updateTabInUrl } from './app/utils/viewRoute';

const LOGIN_PATH = '/login';

function normalizeRoutePath(pathname: string): string {
  if (!pathname) {
    return '/';
  }

  const trimmed = pathname.trim();
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    return trimmed.slice(0, -1);
  }

  return trimmed;
}

function resolveSafePostLoginPath(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  const url = new URL(window.location.href);
  const requested = (url.searchParams.get('next') ?? '').trim();
  if (!requested || !requested.startsWith('/') || requested.startsWith('//')) {
    return '/';
  }

  if (normalizeRoutePath(requested) === LOGIN_PATH) {
    return '/';
  }

  return requested;
}

function redirectToLoginRoute(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const currentUrl = new URL(window.location.href);
  if (normalizeRoutePath(currentUrl.pathname) === LOGIN_PATH) {
    return;
  }

  const nextPath = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  currentUrl.pathname = LOGIN_PATH;
  currentUrl.search = '';
  currentUrl.searchParams.set('next', nextPath.startsWith('/') ? nextPath : '/');
  window.history.replaceState({}, '', currentUrl);
}

function replaceRoute(path: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const target = path.trim().length > 0 ? path : '/';
  const absolute = new URL(target, window.location.origin);
  window.history.replaceState({}, '', absolute);
}

export default function App() {
  const [activeTab, setActiveTabState] = useState<Tab>(() => readTabFromUrl());
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [authReady, setAuthReady] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [googleClientId, setGoogleClientId] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState<AppAuthStatusResponse['user'] | null>(null);
  const [authError, setAuthError] = useState('');
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
  const providerReauthNoticeAtRef = useRef(0);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => (
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  ));
  const hydratedActiveTabPreferenceRef = useRef(false);
  const preferencesSyncInitializedRef = useRef(false);
  const preferenceSaveRequestIdRef = useRef(0);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const isLoginRoute = typeof window !== 'undefined'
    && normalizeRoutePath(window.location.pathname) === LOGIN_PATH;
  const canUseAuthedApis = authReady && (!authEnabled || authenticated);
  const canUseRealtimeApis = canUseAuthedApis && isDocumentVisible;

  const bootstrap = useBootstrapData(canUseAuthedApis);
  const {
    providers, providerStatuses, workspaces, activeWorkspaceId,
    sessions, setSessions, selectedSessionId, setSelectedSessionId,
    defaultLlmControls, setDefaultLlmControls,
    workPlanningProvider, setWorkPlanningProvider,
    workPlanningModel, setWorkPlanningModel,
    workProvider, setWorkProvider, workModel, setWorkModel,
    deliveryStrategy, setDeliveryStrategy,
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

  useSessionsStatusStream({ enabled: canUseRealtimeApis, selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions });
  useSessionPolling({ enabled: canUseRealtimeApis, selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions, setChatMessages, setTodos });
  useSessionStream({ enabled: canUseRealtimeApis, selectedSessionId, setSessions, setChatMessages, setTodos, setNodeTokenStreams, setObserverState });
  useRunUrlSync(selectedSessionId, setSessionSelection);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && normalizeRoutePath(window.location.pathname) === LOGIN_PATH) {
      return;
    }

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
    if (!authReady) {
      return;
    }

    if (authEnabled && !authenticated && !isLoginRoute) {
      redirectToLoginRoute();
    }
  }, [authEnabled, authReady, authenticated, isLoginRoute]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleAuthExpired = () => {
      if (!authEnabled) {
        return;
      }

      clearStoredAuthToken();
      setAuthenticated(false);
      setAuthUser(null);
      setAuthError('Session expired. Please sign in again.');
    };

    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired as EventListener);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired as EventListener);
    };
  }, [authEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleProviderReauthRequired = (event: Event) => {
      const nowMs = Date.now();
      if (nowMs - providerReauthNoticeAtRef.current < 3000) {
        return;
      }

      providerReauthNoticeAtRef.current = nowMs;
      const detail = (event as CustomEvent<{ provider?: string }>).detail;
      const providerLabel = detail?.provider ? `Provider ${detail.provider}` : 'Provider';
      onSettingsSaveStatus('error', `${providerLabel} needs re-login. Reconnect it in Settings > Providers.`);
      setActiveTabState('settings');
      updateTabInUrl('settings', 'replace');
    };

    window.addEventListener(PROVIDER_REAUTH_REQUIRED_EVENT, handleProviderReauthRequired as EventListener);
    return () => {
      window.removeEventListener(PROVIDER_REAUTH_REQUIRED_EVENT, handleProviderReauthRequired as EventListener);
    };
  }, [onSettingsSaveStatus]);

  useEffect(() => {
    if (!authReady) {
      return;
    }

    if ((!authEnabled || authenticated) && isLoginRoute) {
      replaceRoute(resolveSafePostLoginPath());
    }
  }, [authEnabled, authReady, authenticated, isLoginRoute]);

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
    workProvider, setWorkProvider, workModel, setWorkModel,
    deliveryStrategy, setDeliveryStrategy,
    workWorkspaceId, setWorkWorkspaceId,
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
    agentModels?: AgentModels;
  }) => {
    const mergedAgentModels: AgentModels = {
      ...defaultLlmControls.agentModels,
      ...(next.agentModels ?? {}),
      planner: {
        ...(defaultLlmControls.agentModels?.planner ?? {}),
        ...(next.agentModels?.planner ?? {}),
        provider: next.planningProvider,
        model: next.planningModel,
      },
      implementer: {
        ...(defaultLlmControls.agentModels?.implementer ?? {}),
        ...(next.agentModels?.implementer ?? {}),
        provider: next.implementationProvider,
        model: next.implementationModel,
      },
    };

    void updateUiPreferences({
      defaultProvider: next.implementationProvider,
      defaultModel: next.implementationModel,
      defaultAgentModels: mergedAgentModels,
      defaultPlanningProvider: next.planningProvider,
      defaultPlanningModel: next.planningModel,
      defaultImplementationProvider: next.implementationProvider,
      defaultImplementationModel: next.implementationModel,
    }).catch(() => undefined);
  }, [defaultLlmControls.agentModels]);

  const setDefaultPlanningProvider = useCallback((nextProvider: string) => {
    const normalizedProvider = typeof nextProvider === 'string' ? nextProvider.trim() : '';
    const resetModel = normalizedProvider !== defaultLlmControls.planningProvider;
    const nextModel = resetModel ? '' : defaultLlmControls.planningModel;

    setDefaultLlmControls((current) => ({
      ...current,
      planningProvider: normalizedProvider,
      planningModel: resetModel ? '' : current.planningModel,
      agentModels: {
        ...current.agentModels,
        planner: {
          ...(current.agentModels?.planner ?? {}),
          provider: normalizedProvider,
          model: nextModel,
        },
      },
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
          agentModels: {
            ...(existing.agentModels ?? {}),
            planner: {
              ...(existing.agentModels?.planner ?? {}),
              provider: normalizedProvider,
              model: nextModel,
            },
          },
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
    setDefaultLlmControls((current) => ({
      ...current,
      planningModel: normalizedModel,
      agentModels: {
        ...current.agentModels,
        planner: {
          ...(current.agentModels?.planner ?? {}),
          provider: current.planningProvider,
          model: normalizedModel,
        },
      },
    }));
    setWorkPlanningModel(normalizedModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          planningModel: normalizedModel,
          agentModels: {
            ...(existing.agentModels ?? {}),
            planner: {
              ...(existing.agentModels?.planner ?? {}),
              provider: existing.planningProvider,
              model: normalizedModel,
            },
          },
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
      agentModels: {
        ...current.agentModels,
        implementer: {
          ...(current.agentModels?.implementer ?? {}),
          provider: normalizedProvider,
          model: nextModel,
        },
      },
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
          agentModels: {
            ...(existing.agentModels ?? {}),
            implementer: {
              ...(existing.agentModels?.implementer ?? {}),
              provider: normalizedProvider,
              model: nextModel,
            },
          },
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
    setDefaultLlmControls((current) => ({
      ...current,
      implementationModel: normalizedModel,
      agentModels: {
        ...current.agentModels,
        implementer: {
          ...(current.agentModels?.implementer ?? {}),
          provider: current.implementationProvider,
          model: normalizedModel,
        },
      },
    }));
    setWorkModel(normalizedModel);
    setLlmControlsBySessionId((current) => {
      const next = { ...current };
      for (const sessionId of Object.keys(next)) {
        const existing = next[sessionId];
        next[sessionId] = {
          ...existing,
          implementationModel: normalizedModel,
          agentModels: {
            ...(existing.agentModels ?? {}),
            implementer: {
              ...(existing.agentModels?.implementer ?? {}),
              provider: existing.implementationProvider,
              model: normalizedModel,
            },
          },
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

  const setDefaultAgentRoleProvider = useCallback((
    role: 'router' | 'reviewer' | 'investigator',
    nextProvider: string,
  ) => {
    const normalizedProvider = typeof nextProvider === 'string' ? nextProvider.trim() : '';
    const currentRoleConfig = defaultLlmControls.agentModels?.[role] ?? {};
    const resetModel = normalizedProvider !== (currentRoleConfig.provider ?? '');
    const nextModel = resetModel ? '' : (currentRoleConfig.model ?? '');

    setDefaultLlmControls((current) => ({
      ...current,
      agentModels: {
        ...current.agentModels,
        [role]: {
          ...(current.agentModels?.[role] ?? {}),
          provider: normalizedProvider,
          model: nextModel,
        },
      },
    }));

    persistPhaseDefaults({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
      agentModels: {
        [role]: {
          ...(defaultLlmControls.agentModels?.[role] ?? {}),
          provider: normalizedProvider,
          model: nextModel,
        },
      },
    });
  }, [
    defaultLlmControls.agentModels,
    defaultLlmControls.implementationModel,
    defaultLlmControls.implementationProvider,
    defaultLlmControls.planningModel,
    defaultLlmControls.planningProvider,
    persistPhaseDefaults,
    setDefaultLlmControls,
  ]);

  const setDefaultAgentRoleModel = useCallback((
    role: 'router' | 'reviewer' | 'investigator',
    nextModel: string,
  ) => {
    const normalizedModel = typeof nextModel === 'string' ? nextModel.trim() : '';

    setDefaultLlmControls((current) => ({
      ...current,
      agentModels: {
        ...current.agentModels,
        [role]: {
          ...(current.agentModels?.[role] ?? {}),
          provider: current.agentModels?.[role]?.provider,
          model: normalizedModel,
        },
      },
    }));

    persistPhaseDefaults({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
      agentModels: {
        [role]: {
          ...(defaultLlmControls.agentModels?.[role] ?? {}),
          provider: defaultLlmControls.agentModels?.[role]?.provider,
          model: normalizedModel,
        },
      },
    });
  }, [
    defaultLlmControls.agentModels,
    defaultLlmControls.implementationModel,
    defaultLlmControls.implementationProvider,
    defaultLlmControls.planningModel,
    defaultLlmControls.planningProvider,
    persistPhaseDefaults,
    setDefaultLlmControls,
  ]);

  const setDefaultRouterProvider = useCallback((nextProvider: string) => {
    setDefaultAgentRoleProvider('router', nextProvider);
  }, [setDefaultAgentRoleProvider]);

  const setDefaultRouterModel = useCallback((nextModel: string) => {
    setDefaultAgentRoleModel('router', nextModel);
  }, [setDefaultAgentRoleModel]);

  const setDefaultReviewerProvider = useCallback((nextProvider: string) => {
    setDefaultAgentRoleProvider('reviewer', nextProvider);
  }, [setDefaultAgentRoleProvider]);

  const setDefaultReviewerModel = useCallback((nextModel: string) => {
    setDefaultAgentRoleModel('reviewer', nextModel);
  }, [setDefaultAgentRoleModel]);

  const setDefaultInvestigatorProvider = useCallback((nextProvider: string) => {
    setDefaultAgentRoleProvider('investigator', nextProvider);
  }, [setDefaultAgentRoleProvider]);

  const setDefaultInvestigatorModel = useCallback((nextModel: string) => {
    setDefaultAgentRoleModel('investigator', nextModel);
  }, [setDefaultAgentRoleModel]);

      const handleStartNewSessionDraft = useCallback(() => {
    setActiveTab('graph');
    setSessionSelection('');
    setChatMessages([]);
    setTodos([]);
    setNodeTokenStreams({});
    setObserverState(null);
    setShowToolsPanel(false);
    updateActiveLlmControls({
      planningProvider: defaultLlmControls.planningProvider,
      planningModel: defaultLlmControls.planningModel,
      implementationProvider: defaultLlmControls.implementationProvider,
      implementationModel: defaultLlmControls.implementationModel,
      agentModels: defaultLlmControls.agentModels,
      deliveryStrategy: defaultLlmControls.deliveryStrategy,
      planningNoToolGuardMode: defaultLlmControls.planningNoToolGuardMode,
    });
  }, [
    defaultLlmControls.agentModels,
    defaultLlmControls.implementationModel,
    defaultLlmControls.implementationProvider,
    defaultLlmControls.deliveryStrategy,
    defaultLlmControls.planningNoToolGuardMode,
    defaultLlmControls.planningModel,
    defaultLlmControls.planningProvider,
    setActiveTab,
    setChatMessages,
    setNodeTokenStreams,
    setObserverState,
    setSessionSelection,
    setShowToolsPanel,
    setTodos,
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
  const liveReasoning = useMemo(() => {
    if (!selectedSessionRunning) {
      return null;
    }

    if (selectedLlmStatus.state === 'using-tools' || selectedLlmStatus.state === 'idle') {
      return null;
    }

    let latest: { taskId: string; phase: 'planning' | 'implementation'; text: string; updatedAt: string } | null = null;
    for (const [taskId, stream] of Object.entries(nodeTokenStreams)) {
      if (!stream.text.trim()) {
        continue;
      }

      if (!latest || Date.parse(stream.updatedAt) > Date.parse(latest.updatedAt)) {
        latest = {
          taskId,
          phase: stream.phase,
          text: stream.text,
          updatedAt: stream.updatedAt,
        };
      }
    }

    return latest;
  }, [nodeTokenStreams, selectedLlmStatus.state, selectedSessionRunning]);
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
    defaultAgentModels: defaultLlmControls.agentModels,
    deliveryStrategy,
    planningNoToolGuardMode,
    autoApprove,
    adaptiveConcurrency, batchConcurrency, batchMinConcurrency,
    setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos,
    setComposerText, setComposerImages, setLlmControlsBySessionId,
  });

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
      defaultDeliveryStrategy: defaultLlmControls.deliveryStrategy,
      defaultAgentModels: defaultLlmControls.agentModels,
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
    defaultLlmControls.deliveryStrategy,
    defaultLlmControls.agentModels,
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

  const sessionSidebarProps = useMemo(() => ({
    activeTab,
    setActiveTab,
    theme,
    setTheme,
    sessions,
    selectedSessionId,
    onSelectSession: setSessionSelection,
    onNewSession: handleStartNewSessionDraft,
    onDeleteSession: async (sessionId: string) => actions.handleDelete(sessionId),
    onRetrySession: async (sessionId: string) => actions.handleRetrySession(sessionId),
  }), [
    activeTab,
    actions,
    handleStartNewSessionDraft,
    selectedSessionId,
    sessions,
    setActiveTab,
    setSessionSelection,
    setTheme,
    theme,
  ]);

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
    liveReasoning,
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
    onApprovePlan: () => actions.handlePlanApproval(true),
    onRejectPlan: () => actions.handlePlanApproval(false),
    providers,
    providerStatuses,
    activeWorkspaceId,
    defaultPlanningProvider: defaultLlmControls.planningProvider,
    defaultPlanningModel: defaultLlmControls.planningModel,
    defaultImplementationProvider: defaultLlmControls.implementationProvider,
    defaultImplementationModel: defaultLlmControls.implementationModel,
    defaultAgentModels: defaultLlmControls.agentModels,
    defaultPlanningNoToolGuardMode: defaultLlmControls.planningNoToolGuardMode,
    onSetDefaultPlanningProvider: setDefaultPlanningProvider,
    onSetDefaultPlanningModel: setDefaultPlanningModel,
    onSetDefaultImplementationProvider: setDefaultImplementationProvider,
    onSetDefaultImplementationModel: setDefaultImplementationModel,
    onSetDefaultRouterProvider: setDefaultRouterProvider,
    onSetDefaultRouterModel: setDefaultRouterModel,
    onSetDefaultReviewerProvider: setDefaultReviewerProvider,
    onSetDefaultReviewerModel: setDefaultReviewerModel,
    onSetDefaultInvestigatorProvider: setDefaultInvestigatorProvider,
    onSetDefaultInvestigatorModel: setDefaultInvestigatorModel,
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
    deliveryStrategy,
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
    onChangeDeliveryStrategy: (next) => updateActiveLlmControls({ deliveryStrategy: next }),
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

  useEffect(() => {
    let cancelled = false;

    const bootstrapAuth = async () => {
      try {
        const config = await fetchAppAuthConfig();
        if (cancelled) {
          return;
        }

        setAuthEnabled(config.authEnabled);
        setGoogleClientId(config.googleClientId ?? '');

        if (!config.authEnabled) {
          setAuthenticated(true);
          setAuthUser(null);
          setAuthError('');
          return;
        }

        const status = await fetchAppAuthStatus();
        if (cancelled) {
          return;
        }

        if (status.authenticated) {
          setAuthenticated(true);
          setAuthUser(status.user ?? null);
          setAuthError('');
          return;
        }

        clearStoredAuthToken();
        setAuthenticated(false);
        setAuthUser(null);
      } catch (error) {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : String(error));
          setAuthenticated(false);
          setAuthUser(null);
        }
      } finally {
        if (!cancelled) {
          setAuthReady(true);
        }
      }
    };

    void bootstrapAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = useCallback((result: { token: string; user?: AppAuthStatusResponse['user'] }) => {
    setStoredAuthToken(result.token);
    setAuthenticated(true);
    setAuthUser(result.user ?? null);
    setAuthError('');
    replaceRoute(resolveSafePostLoginPath());
  }, []);

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-700 dark:bg-slate-950 dark:text-slate-200">
        Checking authentication…
      </div>
    );
  }

  if (authEnabled && !authenticated) {
    return (
      <>
        <LoginGate
          googleClientId={googleClientId}
          onAuthenticated={handleAuthenticated}
        />
        {authError && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 shadow dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
            Authentication error: {authError}
          </div>
        )}
      </>
    );
  }

  return (

    <AppShell
      sessionSidebarProps={sessionSidebarProps}
      mainContentProps={mainContentProps}
      llmModalProps={llmModalProps}
      authUser={authUser ?? null}
      onLogout={() => {
        void logoutAppAuth();
        clearStoredAuthToken();
        setAuthenticated(false);
        setAuthUser(null);
        setAuthError('');
      }}
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