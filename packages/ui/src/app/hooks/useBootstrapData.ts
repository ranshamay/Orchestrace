import { useEffect, useState } from 'react';
import {
  fetchGithubAuthStatus,
  fetchProviders,
  fetchSessions,
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
    useWorktree: false,
    adaptiveConcurrency: false,
    batchConcurrency: 8,
    batchMinConcurrency: 1,
  });

  const [workProvider, setWorkProvider] = useState('');
  const [workModel, setWorkModel] = useState('');
  const [workWorkspaceId, setWorkWorkspaceId] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [adaptiveConcurrency, setAdaptiveConcurrency] = useState(false);
  const [batchConcurrency, setBatchConcurrency] = useState(8);
  const [batchMinConcurrency, setBatchMinConcurrency] = useState(1);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [providersState, workspacesState, sessionsState, githubAuthStatusResponse] = await Promise.all([
          fetchProviders(),
          fetchWorkspaces(),
          fetchSessions(),
          fetchGithubAuthStatus(),
        ]);

        setProviders(providersState.providers);
        setProviderStatuses(providersState.statuses);
        setWorkspaces(workspacesState.workspaces);
        setActiveWorkspaceId(workspacesState.activeWorkspaceId ?? '');
        setSessions(sessionsState.sessions);
        setGithubAuthStatus(githubAuthStatusResponse.status);

        const runIdFromUrl = readRunIdFromUrl();
        const hasRunIdInResults = Boolean(runIdFromUrl && sessionsState.sessions.some((session) => session.id === runIdFromUrl));
        const initialSessionId = hasRunIdInResults ? runIdFromUrl : sessionsState.sessions[0]?.id ?? '';

        setSelectedSessionId(initialSessionId);
        updateRunIdInUrl(initialSessionId);

        const connectedProvider = providersState.statuses.find((status) => status.source !== 'none')?.provider || '';
        const defaultProvider = connectedProvider || providersState.defaults.provider || providersState.providers[0]?.id || '';
        const defaultWorkspace = workspacesState.activeWorkspaceId || workspacesState.workspaces[0]?.id || '';
        const initialControls: SessionLlmControls = {
          provider: defaultProvider,
          model: providersState.defaults.model || '',
          workspaceId: defaultWorkspace,
          autoApprove: true,
          useWorktree: window.localStorage.getItem('orchestrace-use-worktree') === 'true',
          adaptiveConcurrency: false,
          batchConcurrency: 8,
          batchMinConcurrency: 1,
        };

        setDefaultLlmControls(initialControls);
        setWorkProvider(initialControls.provider);
        setWorkModel(initialControls.model);
        setWorkWorkspaceId(initialControls.workspaceId);
        setAutoApprove(initialControls.autoApprove);
        setUseWorktree(initialControls.useWorktree);
        setAdaptiveConcurrency(initialControls.adaptiveConcurrency);
        setBatchConcurrency(initialControls.batchConcurrency);
        setBatchMinConcurrency(initialControls.batchMinConcurrency);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };

    void bootstrap();
  }, []);

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
  };
}