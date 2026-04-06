import { useEffect, useState } from 'react';
import { GitBranch, Settings } from 'lucide-react';
import {
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
} from '../../../lib/api';

type Props = {
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

export function SettingsTabView({
  providers,
  providerStatuses,
  workspaces,
  activeWorkspaceId,
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

  useEffect(() => {
    setDisplayProviderStatuses(providerStatuses);
  }, [providerStatuses]);

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
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Providers</h3>
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
    </div>
  );
}