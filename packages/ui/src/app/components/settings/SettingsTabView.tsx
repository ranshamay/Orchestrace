import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, GitBranch, Loader2, Settings, Zap } from 'lucide-react';
import {
  type AgentModels,
  fetchProviderAuthSession,
  fetchProviders,
  fetchGithubDeviceAuthSession,
  respondProviderAuthSession,
  startProviderAuth,
  type ProviderAuthSession,
  startGithubDeviceAuth,
  type GithubDeviceAuthSession,
  type ProviderInfo,
  type Workspace,
  fetchObserverStatus,
  fetchObserverFindings,
  fetchObserverFailedSessions,
  fetchModels,
  enableObserver,
  disableObserver,
  updateObserverConfig,
  triggerObserverAnalysis,
  type ObserverStatusResponse,
  type ObserverFinding,
  type ObserverFailedSessionMonitor,
} from '../../../lib/api';
import type { SettingsSaveToastState } from '../overlays/SettingsSaveToast';
import { ModelAutocomplete } from '../ModelAutocomplete';

type AssessmentCategory =
  | 'code-quality'
  | 'performance'
  | 'agent-efficiency'
  | 'architecture'
  | 'test-coverage';

const ASSESSMENT_CATEGORY_OPTIONS: Array<{ value: AssessmentCategory; label: string }> = [
  { value: 'code-quality', label: 'Code Quality' },
  { value: 'performance', label: 'Performance' },
  { value: 'agent-efficiency', label: 'Agent Efficiency' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'test-coverage', label: 'Test Coverage' },
];

function useConnectedDefaultProviderModels(params: {
  connectedDefaultProviders: ProviderInfo[];
  provider: string;
  model: string;
  setModel: (next: string) => void;
}) {
  const {
    connectedDefaultProviders,
    provider,
    model,
    setModel,
  } = params;

  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvedFor, setResolvedFor] = useState('');

      useEffect(() => {
    if (!provider) {
      queueMicrotask(() => {
        setLoading(false);
        setResolvedFor('');
        setModels([]);
      });
      return;
    }

    if (!connectedDefaultProviders.some((entry) => entry.id === provider)) {
      queueMicrotask(() => {
        setLoading(false);
        setResolvedFor('');
        setModels([]);
      });
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      setLoading(true);
      setResolvedFor('');
    });
        void fetchModels(provider)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setModels(response.models);
        setLoading(false);
        setResolvedFor(provider);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setModels([]);
        setLoading(false);
        setResolvedFor(provider);
      });

    return () => {
      cancelled = true;
    };
  }, [connectedDefaultProviders, provider]);

  useEffect(() => {
    if (!provider) {
      return;
    }

    if (loading) {
      return;
    }

    if (resolvedFor !== provider) {
      return;
    }

    if (models.length === 0) {
      return;
    }

    if (model.length > 0 && models.includes(model)) {
      return;
    }

    setModel(models[0]);
  }, [loading, model, models, provider, resolvedFor, setModel]);

  return { models, loading };
}

type Props = {
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  defaultPlanningProvider: string;
  defaultPlanningModel: string;
  defaultImplementationProvider: string;
  defaultImplementationModel: string;
  defaultAgentModels: AgentModels;
  defaultPlanningNoToolGuardMode: 'enforce' | 'warn';
  setDefaultPlanningProvider: (next: string) => void;
  setDefaultPlanningModel: (next: string) => void;
  setDefaultImplementationProvider: (next: string) => void;
  setDefaultImplementationModel: (next: string) => void;
  setDefaultRouterProvider: (next: string) => void;
  setDefaultRouterModel: (next: string) => void;
  setDefaultReviewerProvider: (next: string) => void;
  setDefaultReviewerModel: (next: string) => void;
  setDefaultInvestigatorProvider: (next: string) => void;
  setDefaultInvestigatorModel: (next: string) => void;
  setDefaultPlanningNoToolGuardMode: (next: 'enforce' | 'warn') => void;
  observerShowFindings: boolean;
  setObserverShowFindings: (next: boolean) => void;
  onSettingsSaveStatus: (state: Exclude<SettingsSaveToastState, 'idle'>, message: string) => void;
};

export function SettingsTabView({
  providers,
  providerStatuses,
  workspaces,
  activeWorkspaceId,
  defaultPlanningProvider,
  defaultPlanningModel,
  defaultImplementationProvider,
  defaultImplementationModel,
  defaultAgentModels,
  defaultPlanningNoToolGuardMode,
  setDefaultPlanningProvider,
  setDefaultPlanningModel,
  setDefaultImplementationProvider,
  setDefaultImplementationModel,
  setDefaultRouterProvider,
  setDefaultRouterModel,
  setDefaultReviewerProvider,
  setDefaultReviewerModel,
  setDefaultInvestigatorProvider,
  setDefaultInvestigatorModel,
  setDefaultPlanningNoToolGuardMode,
  observerShowFindings,
  setObserverShowFindings,
  onSettingsSaveStatus,
}: Props) {
  const [githubOauthClientId, setGithubOauthClientId] = useState('');
  const [deviceAuthSessionId, setDeviceAuthSessionId] = useState('');
  const [deviceAuthSession, setDeviceAuthSession] = useState<GithubDeviceAuthSession | null>(null);
  const [deviceAuthPending, setDeviceAuthPending] = useState(false);
  const [displayProviderStatuses, setDisplayProviderStatuses] = useState(providerStatuses);
  const [providerAuthPendingById, setProviderAuthPendingById] = useState<Record<string, boolean>>({});
  const [providerAuthSessionIds, setProviderAuthSessionIds] = useState<Record<string, string>>({});
  const [providerAuthSessions, setProviderAuthSessions] = useState<Record<string, ProviderAuthSession>>({});
  const [providerAuthPromptInputs, setProviderAuthPromptInputs] = useState<Record<string, string>>({});
  const [providersCollapsed, setProvidersCollapsed] = useState(false);

  const connectedDefaultProviders = useMemo(() => {
    const connectedProviderIds = new Set(
      displayProviderStatuses.filter((entry) => entry.source !== 'none').map((entry) => entry.provider),
    );
    return providers.filter((provider) => connectedProviderIds.has(provider.id));
  }, [displayProviderStatuses, providers]);

  useEffect(() => {
    setDisplayProviderStatuses(providerStatuses);
  }, [providerStatuses]);

  const planningDefaults = useConnectedDefaultProviderModels({
    connectedDefaultProviders,
    provider: defaultPlanningProvider,
    model: defaultPlanningModel,
    setModel: setDefaultPlanningModel,
  });

  const implementationDefaults = useConnectedDefaultProviderModels({
    connectedDefaultProviders,
    provider: defaultImplementationProvider,
    model: defaultImplementationModel,
    setModel: setDefaultImplementationModel,
  });

  const routerProvider = defaultAgentModels.router?.provider ?? '';
  const routerModel = defaultAgentModels.router?.model ?? '';
  const reviewerProvider = defaultAgentModels.reviewer?.provider ?? '';
  const reviewerModel = defaultAgentModels.reviewer?.model ?? '';
  const investigatorProvider = defaultAgentModels.investigator?.provider ?? '';
  const investigatorModel = defaultAgentModels.investigator?.model ?? '';

  const routerDefaults = useConnectedDefaultProviderModels({
    connectedDefaultProviders,
    provider: routerProvider,
    model: routerModel,
    setModel: setDefaultRouterModel,
  });

  const reviewerDefaults = useConnectedDefaultProviderModels({
    connectedDefaultProviders,
    provider: reviewerProvider,
    model: reviewerModel,
    setModel: setDefaultReviewerModel,
  });

  const investigatorDefaults = useConnectedDefaultProviderModels({
    connectedDefaultProviders,
    provider: investigatorProvider,
    model: investigatorModel,
    setModel: setDefaultInvestigatorModel,
  });

  useEffect(() => {
    const sessionEntries = Object.entries(providerAuthSessionIds);
    if (sessionEntries.length === 0) {
      return;
    }

    let disposed = false;

    const poll = async () => {
      let refreshStatuses = false;

      await Promise.all(
        sessionEntries.map(async ([providerId, sessionId]) => {
          try {
            const response = await fetchProviderAuthSession(sessionId);
            if (disposed) {
              return;
            }

            setProviderAuthSessions((current) => ({
              ...current,
              [providerId]: response.session,
            }));

            if (response.session.state === 'completed') {
              refreshStatuses = true;
              setProviderAuthSessionIds((current) => {
                const next = { ...current };
                delete next[providerId];
                return next;
              });
            }

            if (response.session.state === 'failed') {
              setProviderAuthSessionIds((current) => {
                const next = { ...current };
                delete next[providerId];
                return next;
              });
            }
          } catch (error) {
            if (disposed) {
              return;
            }

            setProviderAuthSessions((current) => ({
              ...current,
              [providerId]: {
                id: sessionId,
                providerId,
                state: 'failed',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
              },
            }));
            setProviderAuthSessionIds((current) => {
              const next = { ...current };
              delete next[providerId];
              return next;
            });
          }
        }),
      );

      if (refreshStatuses && !disposed) {
        try {
          const providersResponse = await fetchProviders();
          if (!disposed) {
            setDisplayProviderStatuses(providersResponse.statuses);
          }
        } catch {
          // Keep current statuses if refresh fails.
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [providerAuthSessionIds]);

  useEffect(() => {
    if (!deviceAuthSessionId) {
      return;
    }

    if (!deviceAuthSession || (deviceAuthSession.state !== 'awaiting-user' && deviceAuthSession.state !== 'polling')) {
      return;
    }

    let disposed = false;

    const poll = async () => {
      try {
        const response = await fetchGithubDeviceAuthSession(deviceAuthSessionId);
        if (disposed) {
          return;
        }

        setDeviceAuthSession(response.session);

        if (response.session.state === 'completed' && !disposed) {
          setDeviceAuthSessionId('');
        }
      } catch (error) {
        if (disposed) {
          return;
        }

        setDeviceAuthSession((current) => {
          if (!current) {
            return {
              id: deviceAuthSessionId,
              state: 'failed',
              userCode: '',
              verificationUri: '',
              scopes: [],
              expiresAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            };
          }

          return {
            ...current,
            state: 'failed',
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        });
        setDeviceAuthSessionId('');
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [deviceAuthSession, deviceAuthSessionId]);

  return (
    <div className="h-full overflow-auto p-8 dark:bg-slate-950">
      <h2 className="mb-5 flex items-center gap-2 text-2xl font-bold text-slate-800 dark:text-slate-100">
        <Settings className="h-6 w-6" />
        Environment Settings
      </h2>

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Defaults</h3>
        <div className="mb-3 text-xs text-slate-600 dark:text-slate-300">
          Configure planner and implementer defaults for <span className="font-semibold">new sessions</span>, then optionally override additional agent roles.
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Planning Phase</div>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Provider</span>
                <select
                  className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={defaultPlanningProvider}
                  onChange={(event) => {
                    setDefaultPlanningProvider(event.target.value);
                  }}
                >
                  <option value="">Use automatic fallback</option>
                  {connectedDefaultProviders.length === 0 && (
                    <option value="" disabled>No connected providers</option>
                  )}
                  {connectedDefaultProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.id}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                <ModelAutocomplete
                  models={planningDefaults.models}
                  value={defaultPlanningModel}
                  onChange={setDefaultPlanningModel}
                  placeholder={defaultPlanningProvider ? 'Search models…' : 'Select provider first'}
                  disabled={!defaultPlanningProvider || planningDefaults.models.length === 0}
                />
              </label>
            </div>
            {defaultPlanningProvider && planningDefaults.models.length === 0 && !planningDefaults.loading && (
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                No models available for the selected planning provider (or provider is not connected).
              </div>
            )}
          </div>

          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Implementation Phase</div>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Provider</span>
                <select
                  className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={defaultImplementationProvider}
                  onChange={(event) => {
                    setDefaultImplementationProvider(event.target.value);
                  }}
                >
                  <option value="">Use automatic fallback</option>
                  {connectedDefaultProviders.length === 0 && (
                    <option value="" disabled>No connected providers</option>
                  )}
                  {connectedDefaultProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.id}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                <ModelAutocomplete
                  models={implementationDefaults.models}
                  value={defaultImplementationModel}
                  onChange={setDefaultImplementationModel}
                  placeholder={defaultImplementationProvider ? 'Search models…' : 'Select provider first'}
                  disabled={!defaultImplementationProvider || implementationDefaults.models.length === 0}
                />
              </label>
            </div>
            {defaultImplementationProvider && implementationDefaults.models.length === 0 && !implementationDefaults.loading && (
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                No models available for the selected implementation provider (or provider is not connected).
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 rounded border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Additional Agent Role Defaults</div>
          <div className="mb-3 text-xs text-slate-600 dark:text-slate-300">
            Optional overrides for router, reviewer, and investigator roles. Leave empty to inherit the implementation defaults.
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Router Role</div>
              <div className="grid grid-cols-1 gap-2">
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Provider</span>
                  <select
                    className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    value={routerProvider}
                    onChange={(event) => {
                      setDefaultRouterProvider(event.target.value);
                    }}
                  >
                    <option value="">Use implementation fallback</option>
                    {connectedDefaultProviders.length === 0 && (
                      <option value="" disabled>No connected providers</option>
                    )}
                    {connectedDefaultProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.id}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                  <ModelAutocomplete
                    models={routerDefaults.models}
                    value={routerModel}
                    onChange={setDefaultRouterModel}
                    placeholder={routerProvider ? 'Search models…' : 'Select provider first'}
                    disabled={!routerProvider || routerDefaults.models.length === 0}
                  />
                </label>
              </div>
            </div>

            <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Reviewer Role</div>
              <div className="grid grid-cols-1 gap-2">
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Provider</span>
                  <select
                    className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    value={reviewerProvider}
                    onChange={(event) => {
                      setDefaultReviewerProvider(event.target.value);
                    }}
                  >
                    <option value="">Use implementation fallback</option>
                    {connectedDefaultProviders.length === 0 && (
                      <option value="" disabled>No connected providers</option>
                    )}
                    {connectedDefaultProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.id}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                  <ModelAutocomplete
                    models={reviewerDefaults.models}
                    value={reviewerModel}
                    onChange={setDefaultReviewerModel}
                    placeholder={reviewerProvider ? 'Search models…' : 'Select provider first'}
                    disabled={!reviewerProvider || reviewerDefaults.models.length === 0}
                  />
                </label>
              </div>
            </div>

            <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Investigator Role</div>
              <div className="grid grid-cols-1 gap-2">
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Provider</span>
                  <select
                    className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    value={investigatorProvider}
                    onChange={(event) => {
                      setDefaultInvestigatorProvider(event.target.value);
                    }}
                  >
                    <option value="">Use implementation fallback</option>
                    {connectedDefaultProviders.length === 0 && (
                      <option value="" disabled>No connected providers</option>
                    )}
                    {connectedDefaultProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.id}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                  <ModelAutocomplete
                    models={investigatorDefaults.models}
                    value={investigatorModel}
                    onChange={setDefaultInvestigatorModel}
                    placeholder={investigatorProvider ? 'Search models…' : 'Select provider first'}
                    disabled={!investigatorProvider || investigatorDefaults.models.length === 0}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
        {connectedDefaultProviders.length === 0 && (
          <div className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            Connect at least one provider below to select a default provider.
          </div>
        )}

        <div className="mt-4 rounded border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Planning Guard</div>
          <div className="mb-2 text-xs text-slate-600 dark:text-slate-300">
            Choose whether no-tool planning guardrails should abort attempts or only emit warnings.
          </div>
          <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
            <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">No-tool guard mode</span>
            <select
              className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={defaultPlanningNoToolGuardMode}
              onChange={(event) => {
                const next = event.target.value === 'warn' ? 'warn' : 'enforce';
                setDefaultPlanningNoToolGuardMode(next);
              }}
            >
              <option value="enforce">Enforce (abort stalled planning attempts)</option>
              <option value="warn">Warn only (never abort from no-tool guards)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
          <GitBranch className="h-4 w-4" />
          GitHub PR Auth
        </h3>
        <div className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Use device flow OAuth for PR purposes. You must have access to the repository in the remote workspace to open and update PRs.
        </div>
        <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
          <div className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Device Flow OAuth</div>
          <div className="mb-3 text-xs text-slate-600 dark:text-slate-300">
            Start browser-based login for GitHub PR operations. Uses the built-in device auth client by default (CLI-style flow). You can optionally provide your own GitHub OAuth app client ID.
          </div>
          <div className="flex flex-col gap-2 md:flex-row">
            <input
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none ring-blue-500 focus:ring-2 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              onChange={(event) => setGithubOauthClientId(event.target.value)}
              placeholder="Optional: custom GitHub OAuth App client ID"
              type="text"
              value={githubOauthClientId}
            />
            <button
              className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={deviceAuthPending}
              onClick={() => {
                setDeviceAuthPending(true);
                const clientId = githubOauthClientId.trim();
                void startGithubDeviceAuth({
                  clientId: clientId.length > 0 ? clientId : undefined,
                }).then((response) => {
                  setDeviceAuthSessionId(response.sessionId);
                  setDeviceAuthSession(response.session);
                }).catch((error) => {
                  setDeviceAuthSession({
                    id: '',
                    state: 'failed',
                    userCode: '',
                    verificationUri: '',
                    scopes: [],
                    expiresAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    error: error instanceof Error ? error.message : String(error),
                  });
                  setDeviceAuthSessionId('');
                }).finally(() => {
                  setDeviceAuthPending(false);
                });
              }}
              type="button"
            >
              {deviceAuthPending ? 'Starting...' : 'Start Device Login'}
            </button>
          </div>

          {deviceAuthSession && (
            <div className="mt-3 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">session state</span>
                <span className={`rounded px-2 py-0.5 ${deviceAuthSession.state === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : deviceAuthSession.state === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                  {deviceAuthSession.state}
                </span>
              </div>
              {deviceAuthSession.userCode && (
                <div className="mt-2 font-mono text-sm text-slate-700 dark:text-slate-200">
                  Code: {deviceAuthSession.userCode}
                </div>
              )}
              {deviceAuthSession.verificationUri && (
                <div className="mt-1">
                  <a
                    className="text-blue-600 underline dark:text-blue-300"
                    href={deviceAuthSession.verificationUriComplete || deviceAuthSession.verificationUri}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open GitHub verification page
                  </a>
                </div>
              )}
              {deviceAuthSession.error && <div className="mt-2 text-red-600 dark:text-red-300">{deviceAuthSession.error}</div>}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Workspaces</h3>
        <div className="space-y-2">
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950">
              <span className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{workspace.path}</span>
              {workspace.id === activeWorkspaceId && (
                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">active</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Execution</h3>
        <div className="text-sm text-slate-700 dark:text-slate-200">
          Runs execute in a dedicated native git worktree.
        </div>
      </div>

      <ObserverSection
        providers={providers}
        providerStatuses={displayProviderStatuses}
        initialShowFindings={observerShowFindings}
        onSetShowFindings={setObserverShowFindings}
        onSettingsSaveStatus={onSettingsSaveStatus}
      />

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Providers</h3>
          <button
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={() => setProvidersCollapsed((current) => !current)}
            type="button"
          >
            {providersCollapsed ? (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                Expand
              </>
            ) : (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                Collapse
              </>
            )}
          </button>
        </div>

        {!providersCollapsed && (
          <>
            <div className="mb-3 text-xs text-slate-600 dark:text-slate-300">
              Configure auth per provider here. OAuth providers support interactive login, and <span className="font-semibold">github-copilot uses device flow</span>.
            </div>
            <div className="space-y-2">
              {providers.map((provider) => {
                const status = displayProviderStatuses.find((entry) => entry.provider === provider.id)?.source ?? 'none';
                const isOauthProvider = provider.authType === 'oauth' || provider.authType === 'mixed';
                const authActionLabel = provider.id === 'github-copilot' ? 'Start Device Flow' : 'Connect OAuth';
                const providerAuthSession = providerAuthSessions[provider.id];
                const providerAuthPromptInput = providerAuthPromptInputs[provider.id] ?? '';
                const providerAuthPending = providerAuthPendingById[provider.id] === true;

                return (
                  <div key={provider.id} className="rounded border border-slate-100 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
                    <div className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="font-mono text-slate-700 dark:text-slate-200">{provider.id}</span>
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-xs ${status === 'none' ? 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                          {status}
                        </span>
                        {isOauthProvider && (
                          <button
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                            disabled={providerAuthPending}
                            onClick={() => {
                              setProviderAuthPendingById((current) => ({
                                ...current,
                                [provider.id]: true,
                              }));
                              void startProviderAuth(provider.id)
                                .then((response) => {
                                  setProviderAuthPromptInputs((current) => ({
                                    ...current,
                                    [provider.id]: '',
                                  }));
                                  setProviderAuthSessions((current) => ({
                                    ...current,
                                    [provider.id]: {
                                      id: response.sessionId,
                                      providerId: provider.id,
                                      state: 'running',
                                      createdAt: new Date().toISOString(),
                                      updatedAt: new Date().toISOString(),
                                    },
                                  }));
                                  setProviderAuthSessionIds((current) => ({
                                    ...current,
                                    [provider.id]: response.sessionId,
                                  }));
                                })
                                .catch((error) => {
                                  setProviderAuthSessions((current) => ({
                                    ...current,
                                    [provider.id]: {
                                      id: '',
                                      providerId: provider.id,
                                      state: 'failed',
                                      createdAt: new Date().toISOString(),
                                      updatedAt: new Date().toISOString(),
                                      error: error instanceof Error ? error.message : String(error),
                                    },
                                  }));
                                  setProviderAuthSessionIds((current) => {
                                    const next = { ...current };
                                    delete next[provider.id];
                                    return next;
                                  });
                                })
                                .finally(() => {
                                  setProviderAuthPendingById((current) => {
                                    const next = { ...current };
                                    delete next[provider.id];
                                    return next;
                                  });
                                });
                            }}
                            type="button"
                          >
                            {providerAuthPending ? 'Starting...' : authActionLabel}
                          </button>
                        )}
                      </div>
                    </div>

                    {providerAuthSession && (
                      <div className="border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            provider auth: {provider.id}
                          </span>
                          <span className={`rounded px-2 py-0.5 ${providerAuthSession.state === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : providerAuthSession.state === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                            {providerAuthSession.state}
                          </span>
                        </div>
                        {providerAuthSession.authInstructions && (
                          <div className="mt-2 whitespace-pre-wrap text-slate-700 dark:text-slate-200">{providerAuthSession.authInstructions}</div>
                        )}
                        {providerAuthSession.authUrl && (
                          <div className="mt-1">
                            <a
                              className="text-blue-600 underline dark:text-blue-300"
                              href={providerAuthSession.authUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open provider verification page
                            </a>
                          </div>
                        )}
                        {providerAuthSession.state === 'awaiting-input' && (
                          <div className="mt-2 flex flex-col gap-2 md:flex-row">
                            <input
                              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none ring-blue-500 focus:ring-2 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setProviderAuthPromptInputs((current) => ({
                                  ...current,
                                  [provider.id]: nextValue,
                                }));
                              }}
                              placeholder={providerAuthSession.promptPlaceholder || 'Enter auth code'}
                              type="text"
                              value={providerAuthPromptInput}
                            />
                            <button
                              className="rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={!providerAuthSession.id}
                              onClick={() => {
                                if (!providerAuthSession.id) {
                                  return;
                                }

                                const value = providerAuthPromptInput.trim();
                                void respondProviderAuthSession(providerAuthSession.id, value)
                                  .then(() => {
                                    setProviderAuthPromptInputs((current) => ({
                                      ...current,
                                      [provider.id]: '',
                                    }));
                                  })
                                  .catch((error) => {
                                    setProviderAuthSessions((current) => {
                                      const activeSession = current[provider.id];
                                      if (!activeSession) {
                                        return current;
                                      }

                                      return {
                                        ...current,
                                        [provider.id]: {
                                          ...activeSession,
                                          state: 'failed',
                                          updatedAt: new Date().toISOString(),
                                          error: error instanceof Error ? error.message : String(error),
                                        },
                                      };
                                    });
                                  });
                              }}
                              type="button"
                            >
                              Submit
                            </button>
                          </div>
                        )}
                        {providerAuthSession.promptMessage && (
                          <div className="mt-2 text-slate-700 dark:text-slate-200">{providerAuthSession.promptMessage}</div>
                        )}
                        {providerAuthSession.error && <div className="mt-2 text-red-600 dark:text-red-300">{providerAuthSession.error}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// -- Observer Agent Settings Section ------------------------------------------

type ObserverSectionProps = {
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  initialShowFindings: boolean;
  onSetShowFindings: (next: boolean) => void;
  onSettingsSaveStatus: (state: Exclude<SettingsSaveToastState, 'idle'>, message: string) => void;
};

function ObserverSection({
  providers,
  providerStatuses,
  initialShowFindings,
  onSetShowFindings,
  onSettingsSaveStatus,
}: ObserverSectionProps) {
  const [status, setStatus] = useState<ObserverStatusResponse | null>(null);
  const [findings, setFindings] = useState<ObserverFinding[]>([]);
  const [failedSessions, setFailedSessions] = useState<ObserverFailedSessionMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{ analyzed: number; findings: number; spawned: number } | null>(null);
  const [editProvider, setEditProvider] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editLogWatcherProvider, setEditLogWatcherProvider] = useState('');
  const [editLogWatcherModel, setEditLogWatcherModel] = useState('');
  const [editFixProvider, setEditFixProvider] = useState('');
  const [editFixModel, setEditFixModel] = useState('');
  const [editCooldown, setEditCooldown] = useState('');
  const [editMaxPromptChars, setEditMaxPromptChars] = useState('');
  const [editMaxSessionsPerBatch, setEditMaxSessionsPerBatch] = useState('');
  const [editRateLimitCooldown, setEditRateLimitCooldown] = useState('');
  const [editMaxRateLimitBackoff, setEditMaxRateLimitBackoff] = useState('');
  const [editAssessmentCategories, setEditAssessmentCategories] = useState<AssessmentCategory[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const lastAutosaveSignatureRef = useRef('');
  const [showFindings, setShowFindings] = useState(initialShowFindings);

  const connectedProviders = useMemo(() => {
    const connectedProviderIds = new Set(
      providerStatuses.filter((entry) => entry.source !== 'none').map((entry) => entry.provider),
    );
    return providers.filter((provider) => connectedProviderIds.has(provider.id));
  }, [providerStatuses, providers]);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, findingsRes, failedSessionsRes] = await Promise.all([
        fetchObserverStatus(),
        fetchObserverFindings(),
        fetchObserverFailedSessions(),
      ]);
      setStatus(statusRes);
      setFindings(findingsRes.findings);
      setFailedSessions(failedSessionsRes.sessions);

      const firstConnectedProviderId = connectedProviders[0]?.id ?? '';
      const nextAnalysisProvider = connectedProviders.some((provider) => provider.id === statusRes.config.provider)
        ? statusRes.config.provider
        : firstConnectedProviderId;
      const nextLogWatcherProvider = connectedProviders.some((provider) => provider.id === statusRes.config.logWatcherProvider)
        ? statusRes.config.logWatcherProvider
        : firstConnectedProviderId;
      const nextFixProvider = connectedProviders.some((provider) => provider.id === statusRes.config.fixProvider)
        ? statusRes.config.fixProvider
        : firstConnectedProviderId;
      const providerSelectionNormalized =
        nextAnalysisProvider !== statusRes.config.provider
        || nextLogWatcherProvider !== statusRes.config.logWatcherProvider
        || nextFixProvider !== statusRes.config.fixProvider;

      // Init edit fields from server config
      setEditProvider(nextAnalysisProvider);
      setEditModel(nextAnalysisProvider === statusRes.config.provider ? statusRes.config.model : '');
      setEditLogWatcherProvider(nextLogWatcherProvider);
      setEditLogWatcherModel(
        nextLogWatcherProvider === statusRes.config.logWatcherProvider
          ? statusRes.config.logWatcherModel
          : '',
      );
      setEditFixProvider(nextFixProvider);
      setEditFixModel(nextFixProvider === statusRes.config.fixProvider ? statusRes.config.fixModel : '');
      setEditCooldown(String(Math.round(statusRes.config.analysisCooldownMs / 1000)));
      setEditMaxPromptChars(String(statusRes.config.maxAnalysisPromptChars ?? 180000));
      setEditMaxSessionsPerBatch(String(statusRes.config.maxSessionsPerAnalysisBatch ?? 3));
      setEditRateLimitCooldown(String(Math.round((statusRes.config.rateLimitCooldownMs ?? 120000) / 1000)));
      setEditMaxRateLimitBackoff(String(Math.round((statusRes.config.maxRateLimitBackoffMs ?? 900000) / 1000)));
      setEditAssessmentCategories(statusRes.config.assessmentCategories);
      setConfigDirty(providerSelectionNormalized);
      if (!providerSelectionNormalized) {
        lastAutosaveSignatureRef.current = '';
      }
    } catch {
      // API not available yet
    } finally {
      setLoading(false);
    }
  }, [connectedProviders]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (connectedProviders.length === 0) {
      setEditProvider('');
      setEditLogWatcherProvider('');
      setEditFixProvider('');
      setEditModel('');
      setEditLogWatcherModel('');
      setEditFixModel('');
      setEditMaxPromptChars('');
      setEditMaxSessionsPerBatch('');
      setEditRateLimitCooldown('');
      setEditMaxRateLimitBackoff('');
      setProviderModels({});
      return;
    }

    setEditProvider((current) => (
      connectedProviders.some((provider) => provider.id === current)
        ? current
        : connectedProviders[0].id
    ));
    setEditLogWatcherProvider((current) => (
      connectedProviders.some((provider) => provider.id === current)
        ? current
        : connectedProviders[0].id
    ));
    setEditFixProvider((current) => (
      connectedProviders.some((provider) => provider.id === current)
        ? current
        : connectedProviders[0].id
    ));
  }, [connectedProviders]);

  useEffect(() => {
    setShowFindings(initialShowFindings);
  }, [initialShowFindings]);

  useEffect(() => {
    let cancelled = false;

    const loadModelsForProvider = async (providerId: string): Promise<void> => {
      try {
        const response = await fetchModels(providerId);
        if (cancelled) {
          return;
        }
        setProviderModels((current) => ({
          ...current,
          [providerId]: response.models,
        }));
      } catch {
        if (cancelled) {
          return;
        }
        setProviderModels((current) => (
          providerId in current
            ? current
            : {
              ...current,
              [providerId]: [],
            }
        ));
      }
    };

    void Promise.all(connectedProviders.map((provider) => loadModelsForProvider(provider.id)));

    return () => {
      cancelled = true;
    };
  }, [connectedProviders]);

  useEffect(() => {
    if (!editProvider) {
      return;
    }

    const models = providerModels[editProvider] ?? [];
    if (models.length === 0) {
      setEditModel('');
      return;
    }

    setEditModel((current) => (
      current.length > 0 && models.includes(current)
        ? current
        : models[0]
    ));
  }, [editProvider, providerModels]);

  useEffect(() => {
    if (!editLogWatcherProvider) {
      return;
    }

    const models = providerModels[editLogWatcherProvider] ?? [];
    if (models.length === 0) {
      setEditLogWatcherModel('');
      return;
    }

    setEditLogWatcherModel((current) => (
      current.length > 0 && models.includes(current)
        ? current
        : models[0]
    ));
  }, [editLogWatcherProvider, providerModels]);

  useEffect(() => {
    if (!editFixProvider) {
      return;
    }

    const models = providerModels[editFixProvider] ?? [];
    if (models.length === 0) {
      setEditFixModel('');
      return;
    }

    setEditFixModel((current) => (
      current.length > 0 && models.includes(current)
        ? current
        : models[0]
    ));
  }, [editFixProvider, providerModels]);

  // Poll status while running
  useEffect(() => {
    if (!status?.state.running) return;
    const timer = window.setInterval(() => {
      void fetchObserverStatus().then(setStatus).catch(() => {});
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [status?.state.running]);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    onSettingsSaveStatus('saving', 'Saving settings...');
    try {
      if (status.config.enabled) {
        await disableObserver();
      } else {
        await enableObserver();
      }
      await refresh();
      onSettingsSaveStatus('saved', 'Settings saved.');
    } catch (error) {
      onSettingsSaveStatus('error', error instanceof Error ? error.message : 'Failed to save settings.');
    } finally {
      setToggling(false);
    }
  }, [onSettingsSaveStatus, refresh, status]);

  const handleTrigger = async () => {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const result = await triggerObserverAnalysis();
      setTriggerResult(result);
      await refresh();
    } finally {
      setTriggering(false);
    }
  };

  const handleSaveConfig = useCallback(async () => {
    if (
      !editProvider
      || !editLogWatcherProvider
      || !editFixProvider
      || !editModel
      || !editLogWatcherModel
      || !editFixModel
      || editAssessmentCategories.length === 0
    ) {
      return;
    }

    const analysisCooldownMs = Math.max(10, Number(editCooldown) || 60) * 1000;
    const maxAnalysisPromptChars = Math.max(20_000, Math.round(Number(editMaxPromptChars) || 180_000));
    const maxSessionsPerAnalysisBatch = Math.max(1, Math.round(Number(editMaxSessionsPerBatch) || 3));
    const rateLimitCooldownMs = Math.max(5, Number(editRateLimitCooldown) || 120) * 1000;
    const maxRateLimitBackoffMs = Math.max(
      rateLimitCooldownMs,
      Math.max(5, Number(editMaxRateLimitBackoff) || 900) * 1000,
    );

    setSavingConfig(true);
    onSettingsSaveStatus('saving', 'Saving settings...');
    try {
      await updateObserverConfig({
        provider: editProvider,
        model: editModel,
        logWatcherProvider: editLogWatcherProvider,
        logWatcherModel: editLogWatcherModel,
        fixProvider: editFixProvider,
        fixModel: editFixModel,
        analysisCooldownMs,
        maxAnalysisPromptChars,
        maxSessionsPerAnalysisBatch,
        rateLimitCooldownMs,
        maxRateLimitBackoffMs,
        assessmentCategories: editAssessmentCategories,
      });
      await refresh();
      onSettingsSaveStatus('saved', 'Settings saved.');
    } finally {
      setSavingConfig(false);
    }
  }, [
    editAssessmentCategories,
    editCooldown,
    editLogWatcherModel,
    editLogWatcherProvider,
    editMaxPromptChars,
    editMaxSessionsPerBatch,
    editRateLimitCooldown,
    editMaxRateLimitBackoff,
    editFixModel,
    editFixProvider,
    editModel,
    editProvider,
    onSettingsSaveStatus,
    refresh,
  ]);

  const markDirty = () => setConfigDirty(true);

  const toggleShowFindings = () => {
    setShowFindings((current) => {
      const next = !current;
      onSetShowFindings(next);
      return next;
    });
  };

  const toggleAssessmentCategory = (category: AssessmentCategory, checked: boolean) => {
    setEditAssessmentCategories((current) => {
      if (checked) {
        if (current.includes(category)) return current;
        return [...current, category];
      }
      return current.filter((value) => value !== category);
    });
    markDirty();
  };

  const enabled = status?.config.enabled ?? false;
  const running = status?.state.running ?? false;
  const analysisModels = editProvider ? (providerModels[editProvider] ?? []) : [];
  const logWatcherModels = editLogWatcherProvider ? (providerModels[editLogWatcherProvider] ?? []) : [];
  const fixModels = editFixProvider ? (providerModels[editFixProvider] ?? []) : [];
  const canSaveConfig =
    configDirty
    && !savingConfig
    && editAssessmentCategories.length > 0
    && connectedProviders.length > 0
    && editProvider.length > 0
    && editLogWatcherProvider.length > 0
    && editFixProvider.length > 0
    && editModel.length > 0
    && editLogWatcherModel.length > 0
    && editFixModel.length > 0
    && editMaxPromptChars.length > 0
    && editMaxSessionsPerBatch.length > 0
    && editRateLimitCooldown.length > 0
    && editMaxRateLimitBackoff.length > 0;

  const configSignature = useMemo(() => JSON.stringify({
    provider: editProvider,
    model: editModel,
    logWatcherProvider: editLogWatcherProvider,
    logWatcherModel: editLogWatcherModel,
    fixProvider: editFixProvider,
    fixModel: editFixModel,
    analysisCooldownMs: Math.max(10, Number(editCooldown) || 60) * 1000,
    maxAnalysisPromptChars: Math.max(20_000, Math.round(Number(editMaxPromptChars) || 180_000)),
    maxSessionsPerAnalysisBatch: Math.max(1, Math.round(Number(editMaxSessionsPerBatch) || 3)),
    rateLimitCooldownMs: Math.max(5, Number(editRateLimitCooldown) || 120) * 1000,
    maxRateLimitBackoffMs: Math.max(
      Math.max(5, Number(editRateLimitCooldown) || 120) * 1000,
      Math.max(5, Number(editMaxRateLimitBackoff) || 900) * 1000,
    ),
    assessmentCategories: editAssessmentCategories,
  }), [
    editAssessmentCategories,
    editCooldown,
    editLogWatcherModel,
    editLogWatcherProvider,
    editFixModel,
    editFixProvider,
    editMaxPromptChars,
    editMaxRateLimitBackoff,
    editMaxSessionsPerBatch,
    editModel,
    editProvider,
    editRateLimitCooldown,
  ]);

  useEffect(() => {
    if (!configDirty || !canSaveConfig || savingConfig) {
      return;
    }

    if (lastAutosaveSignatureRef.current === configSignature) {
      return;
    }

    lastAutosaveSignatureRef.current = configSignature;
    const timer = window.setTimeout(() => {
      void handleSaveConfig().catch((error) => {
        onSettingsSaveStatus('error', error instanceof Error ? error.message : 'Failed to save settings.');
      });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [canSaveConfig, configDirty, configSignature, handleSaveConfig, onSettingsSaveStatus, savingConfig]);

  return (
    <div className="mt-6 rounded-lg border border-violet-200 bg-white p-5 shadow-sm dark:border-violet-800 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-400">
          <Eye className="h-4 w-4" />
          Observer Agent
        </h3>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        ) : (
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${running ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {running ? 'Running' : 'Stopped'}
            </span>
            <button
              className={`rounded px-3 py-1 text-xs font-semibold ${enabled ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60' : 'bg-violet-600 text-white hover:bg-violet-500'}`}
              disabled={toggling}
              onClick={() => { void handleToggle(); }}
              type="button"
            >
              {toggling ? 'Updating...' : enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        )}
      </div>

      <p className="mb-4 text-xs text-slate-600 dark:text-slate-300">
        The observer agent continuously watches completed sessions, analyzes them via LLM for optimization opportunities, and autonomously spawns fix sessions.
      </p>

      {status && (
        <>
          {/* Stats row */}
          <div className="mb-4 flex flex-wrap gap-2">
            <span className="rounded bg-slate-100 px-2 py-1 text-[10px] dark:bg-slate-800">
              Analyzed: <span className="font-semibold">{status.state.analyzedCount}</span>
            </span>
            <span className="rounded bg-violet-100 px-2 py-1 text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              Findings: <span className="font-semibold">{status.state.totalFindings}</span>
            </span>
            <span className="rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              Pending fixes: <span className="font-semibold">{status.state.pendingFindings}</span>
            </span>
            {status.state.lastAnalysisAt && (
              <span className="rounded bg-slate-100 px-2 py-1 text-[10px] dark:bg-slate-800">
                Last analysis: {new Date(status.state.lastAnalysisAt).toLocaleTimeString()}
              </span>
            )}
            {status.state.rateLimitedUntil && (
              <span className="rounded bg-red-100 px-2 py-1 text-[10px] text-red-700 dark:bg-red-900/30 dark:text-red-300">
                Rate limited until: {new Date(status.state.rateLimitedUntil).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Manual trigger */}
          <div className="mb-4 flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 rounded bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={triggering}
              onClick={() => { void handleTrigger(); }}
              type="button"
            >
              {triggering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
              {triggering ? 'Analyzing...' : 'Trigger Analysis Now'}
            </button>
            {triggerResult && (
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                Analyzed {triggerResult.analyzed} session(s), found {triggerResult.findings} issue(s), spawned {triggerResult.spawned} fix(es)
              </span>
            )}
          </div>

          {/* Config section */}
          <div className="mb-4 rounded border border-slate-200 p-3 dark:border-slate-700">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Configuration</h4>

            {connectedProviders.length === 0 && (
              <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                No authenticated providers are connected. Connect a provider above to configure observer models.
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Analysis Provider</span>
                <select
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  value={editProvider}
                  onChange={(event) => {
                    setEditProvider(event.target.value);
                    setEditModel('');
                    markDirty();
                  }}
                  disabled={connectedProviders.length === 0}
                >
                  {connectedProviders.length === 0 && <option value="">No connected providers</option>}
                  {connectedProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.id}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Analysis Model</span>
                <ModelAutocomplete
                  models={analysisModels}
                  value={editModel}
                  onChange={(model) => {
                    setEditModel(model);
                    markDirty();
                  }}
                  placeholder="Search models…"
                  disabled={analysisModels.length === 0}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Log Watcher Provider</span>
                <select
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  value={editLogWatcherProvider}
                  onChange={(event) => {
                    setEditLogWatcherProvider(event.target.value);
                    setEditLogWatcherModel('');
                    markDirty();
                  }}
                  disabled={connectedProviders.length === 0}
                >
                  {connectedProviders.length === 0 && <option value="">No connected providers</option>}
                  {connectedProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.id}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Log Watcher Model</span>
                <ModelAutocomplete
                  models={logWatcherModels}
                  value={editLogWatcherModel}
                  onChange={(model) => {
                    setEditLogWatcherModel(model);
                    markDirty();
                  }}
                  placeholder="Search models…"
                  disabled={logWatcherModels.length === 0}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Fix Session Provider</span>
                <select
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  value={editFixProvider}
                  onChange={(event) => {
                    setEditFixProvider(event.target.value);
                    setEditFixModel('');
                    markDirty();
                  }}
                  disabled={connectedProviders.length === 0}
                >
                  {connectedProviders.length === 0 && <option value="">No connected providers</option>}
                  {connectedProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.id}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Fix Session Model</span>
                <ModelAutocomplete
                  models={fixModels}
                  value={editFixModel}
                  onChange={(model) => {
                    setEditFixModel(model);
                    markDirty();
                  }}
                  placeholder="Search models…"
                  disabled={fixModels.length === 0}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Cooldown (seconds)</span>
                <input
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  type="number"
                  min={10}
                  value={editCooldown}
                  onChange={(e) => { setEditCooldown(e.target.value); markDirty(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Max Prompt Chars</span>
                <input
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  type="number"
                  min={20000}
                  step={1000}
                  value={editMaxPromptChars}
                  onChange={(e) => { setEditMaxPromptChars(e.target.value); markDirty(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Max Sessions Per Batch</span>
                <input
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  type="number"
                  min={1}
                  max={50}
                  value={editMaxSessionsPerBatch}
                  onChange={(e) => { setEditMaxSessionsPerBatch(e.target.value); markDirty(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Rate Limit Cooldown (seconds)</span>
                <input
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  type="number"
                  min={5}
                  value={editRateLimitCooldown}
                  onChange={(e) => { setEditRateLimitCooldown(e.target.value); markDirty(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-200">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Max Backoff (seconds)</span>
                <input
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  type="number"
                  min={5}
                  value={editMaxRateLimitBackoff}
                  onChange={(e) => { setEditMaxRateLimitBackoff(e.target.value); markDirty(); }}
                />
              </label>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                What To Assess
              </div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {ASSESSMENT_CATEGORY_OPTIONS.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
                      checked={editAssessmentCategories.includes(option.value)}
                      onChange={(event) => toggleAssessmentCategory(option.value, event.target.checked)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {editAssessmentCategories.length === 0 && (
                <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                  Select at least one category.
                </div>
              )}
            </div>

            {(configDirty || savingConfig) && (
              <div className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                {savingConfig
                  ? 'Saving configuration...'
                  : canSaveConfig
                    ? 'Changes are saved automatically.'
                    : 'Complete required fields to save changes.'}
              </div>
            )}
          </div>

          {/* Failed session monitor */}
          <div className="mb-4 rounded border border-slate-200 p-3 dark:border-slate-700">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Failed Sessions Monitor</h4>
            {failedSessions.length === 0 ? (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                No failed user sessions detected.
              </div>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {failedSessions.map((session) => (
                  <div key={session.sessionId} className="rounded border border-slate-200 p-2 text-xs dark:border-slate-700">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${session.observer.analyzed ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                        {session.observer.analyzed ? 'analyzed' : 'queued'}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {session.workspaceName}
                      </span>
                      <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{session.sessionId.slice(0, 12)}</span>
                    </div>
                    <div className="line-clamp-2 text-slate-700 dark:text-slate-200">{session.prompt}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                      <span>findings: {session.observer.findings}</span>
                      <span>pending: {session.observer.fixStatusCounts.pending}</span>
                      <span>spawned: {session.observer.fixStatusCounts.spawned}</span>
                      <span>completed: {session.observer.fixStatusCounts.completed}</span>
                      <span>failed: {session.observer.fixStatusCounts.failed}</span>
                      {session.observer.latestFindingAt && (
                        <span>last finding: {new Date(session.observer.latestFindingAt).toLocaleTimeString()}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Findings list */}
          {findings.length > 0 && (
            <div>
              <button
                className="mb-2 text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-400"
                onClick={toggleShowFindings}
                type="button"
              >
                {showFindings ? 'Hide' : 'Show'} Findings ({findings.length})
              </button>
              {showFindings && (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {findings.map((f) => (
                    <div key={f.fingerprint} className="rounded border border-slate-200 p-2 text-xs dark:border-slate-700">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${severityBadge(f.severity)}`}>{f.severity}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${categoryBadge(f.category)}`}>{f.category}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${fixStatusBadge(f.fixStatus)}`}>{f.fixStatus}</span>
                      </div>
                      <div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{f.title}</div>
                      <div className="mt-0.5 text-slate-600 dark:text-slate-300">{f.description}</div>
                      {f.relevantFiles && f.relevantFiles.length > 0 && (
                        <div className="mt-1 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                          {f.relevantFiles.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function severityBadge(severity: string): string {
  switch (severity) {
    case 'critical': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'high': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'medium': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'low': return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
    default: return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function categoryBadge(category: string): string {
  switch (category) {
    case 'code-quality': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'performance': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'agent-efficiency': return 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300';
    case 'architecture': return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'test-coverage': return 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300';
    default: return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function fixStatusBadge(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'spawned': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'failed': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'pending': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    default: return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}