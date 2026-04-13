import { useEffect, useState } from 'react';
import {
  type AgentModels,
  type UiPreferences,
  fetchGithubAuthStatus,
  fetchProviders,
  fetchSessions,
  fetchUiPreferences,
  fetchWorkspaces,
  type GithubAuthStatus,
  type ProviderInfo,
  type WorkSession,
  type Workspace,
} from '../../lib/api';
import type { SessionLlmControls } from '../types';
import { readRunIdFromUrl, updateRunIdInUrl } from '../utils/runUrl';
import { sortSessionsByActivityAndRecency } from '../utils/sessionSort';
import { readTabFromUrl } from '../utils/viewRoute';

type ProviderStatus = { provider: string; source: string };

export function useBootstrapData(enabled = true) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [githubAuthStatus, setGithubAuthStatus] = useState<GithubAuthStatus>({
    connected: false,
    source: 'none',
    storedApiKeyConfigured: false,
    scopes: [],
  });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => readRunIdFromUrl());

  const [defaultLlmControls, setDefaultLlmControls] = useState<SessionLlmControls>({
    planningProvider: '',
    planningModel: '',
    implementationProvider: '',
    implementationModel: '',
    agentModels: {},
    deliveryStrategy: 'pr-only',
    planningNoToolGuardMode: 'enforce',
    workspaceId: '',
    autoApprove: true,
    quickStartMode: false,
    quickStartMaxPreDelegationToolCalls: 3,
    adaptiveConcurrency: false,
    batchConcurrency: 8,
    batchMinConcurrency: 1,
    enableTrivialTaskGate: false,
    trivialTaskMaxPromptLength: 120,
  });

  const [workPlanningProvider, setWorkPlanningProvider] = useState('');
  const [workPlanningModel, setWorkPlanningModel] = useState('');
  const [workProvider, setWorkProvider] = useState('');
  const [workModel, setWorkModel] = useState('');
  const [deliveryStrategy, setDeliveryStrategy] = useState<'pr-only' | 'merge-after-ci'>('pr-only');
  const [workWorkspaceId, setWorkWorkspaceId] = useState('');
  const [planningNoToolGuardMode, setPlanningNoToolGuardMode] = useState<'enforce' | 'warn'>('enforce');
  const [autoApprove, setAutoApprove] = useState(true);
  const [quickStartMode, setQuickStartMode] = useState(false);
  const [quickStartMaxPreDelegationToolCalls, setQuickStartMaxPreDelegationToolCalls] = useState(3);
  const [adaptiveConcurrency, setAdaptiveConcurrency] = useState(false);
  const [batchConcurrency, setBatchConcurrency] = useState(8);
  const [batchMinConcurrency, setBatchMinConcurrency] = useState(1);
  const [enableTrivialTaskGate, setEnableTrivialTaskGate] = useState(false);
  const [trivialTaskMaxPromptLength, setTrivialTaskMaxPromptLength] = useState(120);
  const [activeTabPreference, setActiveTabPreference] = useState<'graph' | 'settings' | 'logs'>(() => readTabFromUrl());
  const [observerShowFindings, setObserverShowFindings] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [bootstrapComplete, setBootstrapComplete] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const bootstrap = async () => {
      try {
        const [providersResult, workspacesResult, sessionsResult, githubAuthStatusResult, preferencesResult] = await Promise.allSettled([
          fetchProviders(),
          fetchWorkspaces(),
          fetchSessions(),
          fetchGithubAuthStatus(),
          fetchUiPreferences(),
        ]);

        const bootstrapErrors: string[] = [];

        let providersState: Awaited<ReturnType<typeof fetchProviders>> | undefined;
        if (providersResult.status === 'fulfilled') {
          providersState = providersResult.value;
          setProviders(providersState.providers);
          setProviderStatuses(providersState.statuses);
        } else {
          bootstrapErrors.push(toErrorMessage(providersResult.reason));
        }

        let workspacesState;
        if (workspacesResult.status === 'fulfilled') {
          workspacesState = workspacesResult.value;
          setWorkspaces(workspacesState.workspaces);
          setActiveWorkspaceId(workspacesState.activeWorkspaceId ?? '');
        } else {
          bootstrapErrors.push(toErrorMessage(workspacesResult.reason));
        }

        let sessionsState;
        if (sessionsResult.status === 'fulfilled') {
          sessionsState = sessionsResult.value;
          const sortedSessions = sortSessionsByActivityAndRecency(sessionsState.sessions);
          setSessions(sortedSessions);

          const runIdFromUrl = readRunIdFromUrl();
          const hasRunIdInResults = Boolean(
            runIdFromUrl && sortedSessions.some((session) => session.id === runIdFromUrl),
          );
          const initialSessionId = hasRunIdInResults ? runIdFromUrl : sortedSessions[0]?.id ?? '';

          setSelectedSessionId(initialSessionId);
          updateRunIdInUrl(initialSessionId);
        } else {
          bootstrapErrors.push(toErrorMessage(sessionsResult.reason));
        }

        if (githubAuthStatusResult.status === 'fulfilled') {
          setGithubAuthStatus(githubAuthStatusResult.value.status);
        }

        const fallbackPreferences: UiPreferences = {
          activeTab: 'graph',
          observerShowFindings: false,
          defaultProvider: '',
          defaultModel: '',
          defaultAgentModels: {},
          defaultPlanningProvider: '',
          defaultPlanningModel: '',
          defaultImplementationProvider: '',
          defaultImplementationModel: '',
          defaultDeliveryStrategy: 'pr-only',
          planningNoToolGuardMode: 'enforce',
          quickStartMode: false,
          quickStartMaxPreDelegationToolCalls: 3,
          adaptiveConcurrency: false,
          batchConcurrency: 8,
          batchMinConcurrency: 1,
          enableTrivialTaskGate: false,
          trivialTaskMaxPromptLength: 5000,
        };
        const preferences = preferencesResult.status === 'fulfilled'
          ? preferencesResult.value.preferences
          : fallbackPreferences;

        if (preferencesResult.status === 'rejected') {
          bootstrapErrors.push(toErrorMessage(preferencesResult.reason));
        }

        const resolvePreferredConnectedProvider = (configuredValue: string | undefined): string => {
          const configured = typeof configuredValue === 'string' ? configuredValue.trim() : '';
          if (!configured) {
            return '';
          }
          return providersState?.statuses.some((status) => status.provider === configured && status.source !== 'none')
            ? configured
            : '';
        };

        const preferredProvider = resolvePreferredConnectedProvider(preferences.defaultProvider);

        const connectedProvider = providersState?.statuses.find((status) => status.source !== 'none')?.provider || '';
        const defaultProvider = preferredProvider
          || connectedProvider
          || providersState?.defaults.provider
          || providersState?.providers[0]?.id
          || '';
        const defaultModel = typeof preferences.defaultModel === 'string'
          ? preferences.defaultModel.trim()
          : '';
        const defaultPlanningProvider = resolvePreferredConnectedProvider(preferences.defaultPlanningProvider) || defaultProvider;
        const defaultPlanningModel = typeof preferences.defaultPlanningModel === 'string'
          ? preferences.defaultPlanningModel.trim()
          : defaultModel;
        const defaultImplementationProvider = resolvePreferredConnectedProvider(preferences.defaultImplementationProvider) || defaultProvider;
        const defaultImplementationModel = typeof preferences.defaultImplementationModel === 'string'
          ? preferences.defaultImplementationModel.trim()
          : defaultModel;
        const defaultAgentModels: AgentModels = {
          ...(preferences.defaultAgentModels ?? {}),
          planner: {
            ...(preferences.defaultAgentModels?.planner ?? {}),
            provider: typeof preferences.defaultAgentModels?.planner?.provider === 'string'
              ? preferences.defaultAgentModels.planner.provider.trim()
              : defaultPlanningProvider,
            model: typeof preferences.defaultAgentModels?.planner?.model === 'string'
              ? preferences.defaultAgentModels.planner.model.trim()
              : defaultPlanningModel,
          },
          implementer: {
            ...(preferences.defaultAgentModels?.implementer ?? {}),
            provider: typeof preferences.defaultAgentModels?.implementer?.provider === 'string'
              ? preferences.defaultAgentModels.implementer.provider.trim()
              : defaultImplementationProvider,
            model: typeof preferences.defaultAgentModels?.implementer?.model === 'string'
              ? preferences.defaultAgentModels.implementer.model.trim()
              : defaultImplementationModel,
          },
        };
        const defaultWorkspace = workspacesState?.activeWorkspaceId || workspacesState?.workspaces[0]?.id || '';

        const initialControls: SessionLlmControls = {
          planningProvider: defaultPlanningProvider,
          planningModel: defaultPlanningModel,
          implementationProvider: defaultImplementationProvider,
          implementationModel: defaultImplementationModel,
          agentModels: defaultAgentModels,
          deliveryStrategy: preferences.defaultDeliveryStrategy === 'merge-after-ci' ? 'merge-after-ci' : 'pr-only',
          planningNoToolGuardMode: preferences.planningNoToolGuardMode === 'warn' ? 'warn' : 'enforce',
          workspaceId: defaultWorkspace,
          autoApprove: true,
          quickStartMode: preferences.quickStartMode ?? false,
          quickStartMaxPreDelegationToolCalls: preferences.quickStartMaxPreDelegationToolCalls ?? 3,
          adaptiveConcurrency: preferences.adaptiveConcurrency,
          batchConcurrency: preferences.batchConcurrency,
          batchMinConcurrency: preferences.batchMinConcurrency,
          enableTrivialTaskGate: preferences.enableTrivialTaskGate ?? false,
          trivialTaskMaxPromptLength: preferences.trivialTaskMaxPromptLength ?? 120,
        };

        setDefaultLlmControls(initialControls);
        setWorkPlanningProvider(initialControls.planningProvider);
        setWorkPlanningModel(initialControls.planningModel);
        setWorkProvider(initialControls.implementationProvider);
        setWorkModel(initialControls.implementationModel);
        setDeliveryStrategy(initialControls.deliveryStrategy);
        setPlanningNoToolGuardMode(initialControls.planningNoToolGuardMode);
        setWorkWorkspaceId(initialControls.workspaceId);
        setAutoApprove(initialControls.autoApprove);
        setQuickStartMode(initialControls.quickStartMode);
        setQuickStartMaxPreDelegationToolCalls(initialControls.quickStartMaxPreDelegationToolCalls);
        setAdaptiveConcurrency(initialControls.adaptiveConcurrency);
        setBatchConcurrency(initialControls.batchConcurrency);
        setBatchMinConcurrency(initialControls.batchMinConcurrency);
        setEnableTrivialTaskGate(initialControls.enableTrivialTaskGate);
        setTrivialTaskMaxPromptLength(initialControls.trivialTaskMaxPromptLength);
        setActiveTabPreference(preferences.activeTab ?? 'graph');
        setObserverShowFindings(preferences.observerShowFindings ?? false);

        if (bootstrapErrors.length > 0) {
          setErrorMessage(bootstrapErrors[0]);
        }
      } catch (error) {
        setErrorMessage(toErrorMessage(error));
      } finally {
        setBootstrapComplete(true);
      }
    };

    void bootstrap();
  }, [enabled]);

  return {
    providers,
    providerStatuses,
    githubAuthStatus,
    setGithubAuthStatus,
    workspaces,
    activeWorkspaceId,
    sessions,
    setSessions,
    selectedSessionId,
    setSelectedSessionId,
    defaultLlmControls,
    setDefaultLlmControls,
    workPlanningProvider,
    setWorkPlanningProvider,
    workPlanningModel,
    setWorkPlanningModel,
    workProvider,
    setWorkProvider,
    workModel,
    setWorkModel,
    deliveryStrategy,
    setDeliveryStrategy,
    workWorkspaceId,
    setWorkWorkspaceId,
    planningNoToolGuardMode,
    setPlanningNoToolGuardMode,
    autoApprove,
    setAutoApprove,
    quickStartMode,
    setQuickStartMode,
    quickStartMaxPreDelegationToolCalls,
    setQuickStartMaxPreDelegationToolCalls,
    adaptiveConcurrency,
    setAdaptiveConcurrency,
    batchConcurrency,
    setBatchConcurrency,
    batchMinConcurrency,
    setBatchMinConcurrency,
    enableTrivialTaskGate,
    setEnableTrivialTaskGate,
    trivialTaskMaxPromptLength,
    setTrivialTaskMaxPromptLength,
    activeTabPreference,
    observerShowFindings,
    setObserverShowFindings,
    errorMessage,
    setErrorMessage,
    bootstrapComplete,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
