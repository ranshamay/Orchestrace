import { useEffect, useState } from 'react';
import {
  type ExecutionContext,
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

type ProviderStatus = { provider: string; source: string };

export function useBootstrapData() {
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
    provider: '',
    model: '',
    workspaceId: '',
    autoApprove: true,
    executionContext: 'workspace',
    selectedWorktreePath: undefined,
    useWorktree: false,
    adaptiveConcurrency: false,
    batchConcurrency: 8,
    batchMinConcurrency: 1,
  });

  const [workProvider, setWorkProvider] = useState('');
  const [workModel, setWorkModel] = useState('');
  const [workWorkspaceId, setWorkWorkspaceId] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [executionContext, setExecutionContext] = useState<ExecutionContext>('workspace');
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [adaptiveConcurrency, setAdaptiveConcurrency] = useState(false);
  const [batchConcurrency, setBatchConcurrency] = useState(8);
  const [batchMinConcurrency, setBatchMinConcurrency] = useState(1);
  const [errorMessage, setErrorMessage] = useState('');
  const [bootstrapComplete, setBootstrapComplete] = useState(false);

  useEffect(() => {
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

        let providersState;
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
          setSessions(sessionsState.sessions);

          const runIdFromUrl = readRunIdFromUrl();
          const hasRunIdInResults = Boolean(
            runIdFromUrl && sessionsState.sessions.some((session) => session.id === runIdFromUrl),
          );
          const initialSessionId = hasRunIdInResults ? runIdFromUrl : sessionsState.sessions[0]?.id ?? '';

          setSelectedSessionId(initialSessionId);
          updateRunIdInUrl(initialSessionId);
        } else {
          bootstrapErrors.push(toErrorMessage(sessionsResult.reason));
        }

        if (githubAuthStatusResult.status === 'fulfilled') {
          setGithubAuthStatus(githubAuthStatusResult.value.status);
        }

        const preferences = preferencesResult.status === 'fulfilled'
          ? preferencesResult.value.preferences
          : {
              executionContext: 'workspace' as const,
              selectedWorktreePath: undefined,
              useWorktree: false,
              adaptiveConcurrency: false,
              batchConcurrency: 8,
              batchMinConcurrency: 1,
            };

        if (preferencesResult.status === 'rejected') {
          bootstrapErrors.push(toErrorMessage(preferencesResult.reason));
        }

        const connectedProvider = providersState?.statuses.find((status) => status.source !== 'none')?.provider || '';
        const defaultProvider = connectedProvider || providersState?.defaults.provider || providersState?.providers[0]?.id || '';
        const defaultWorkspace = workspacesState?.activeWorkspaceId || workspacesState?.workspaces[0]?.id || '';
        const defaultExecutionContext: ExecutionContext = preferences.executionContext
          ?? (preferences.useWorktree ? 'git-worktree' : 'workspace');
        const initialControls: SessionLlmControls = {
          provider: defaultProvider,
          model: '',
          workspaceId: defaultWorkspace,
          autoApprove: true,
          executionContext: defaultExecutionContext,
          selectedWorktreePath: preferences.selectedWorktreePath,
          useWorktree: defaultExecutionContext === 'git-worktree',
          adaptiveConcurrency: preferences.adaptiveConcurrency,
          batchConcurrency: preferences.batchConcurrency,
          batchMinConcurrency: preferences.batchMinConcurrency,
        };

        setDefaultLlmControls(initialControls);
        setWorkProvider(initialControls.provider);
        setWorkModel(initialControls.model);
        setWorkWorkspaceId(initialControls.workspaceId);
        setAutoApprove(initialControls.autoApprove);
        setExecutionContext(initialControls.executionContext);
        setSelectedWorktreePath(initialControls.selectedWorktreePath ?? '');
        setUseWorktree(initialControls.useWorktree);
        setAdaptiveConcurrency(initialControls.adaptiveConcurrency);
        setBatchConcurrency(initialControls.batchConcurrency);
        setBatchMinConcurrency(initialControls.batchMinConcurrency);

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
  }, []);

  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

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
    workProvider,
    setWorkProvider,
    workModel,
    setWorkModel,
    workWorkspaceId,
    setWorkWorkspaceId,
    autoApprove,
    setAutoApprove,
    executionContext,
    setExecutionContext,
    selectedWorktreePath,
    setSelectedWorktreePath,
    useWorktree,
    setUseWorktree,
    adaptiveConcurrency,
    setAdaptiveConcurrency,
    batchConcurrency,
    setBatchConcurrency,
    batchMinConcurrency,
    setBatchMinConcurrency,
    errorMessage,
    setErrorMessage,
    bootstrapComplete,
  };
}