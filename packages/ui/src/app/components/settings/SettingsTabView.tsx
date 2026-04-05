import { useEffect, useState } from 'react';
import { GitBranch, Settings } from 'lucide-react';
import {
  fetchGithubDeviceAuthSession,
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
  useWorktree: boolean;
  setUseWorktree: (next: boolean) => void;
};

export function SettingsTabView({
  providers,
  providerStatuses,
  workspaces,
  activeWorkspaceId,
  useWorktree,
  setUseWorktree,
}: Props) {
  const [githubOauthClientId, setGithubOauthClientId] = useState('');
  const [deviceAuthSessionId, setDeviceAuthSessionId] = useState('');
  const [deviceAuthSession, setDeviceAuthSession] = useState<GithubDeviceAuthSession | null>(null);
  const [deviceAuthPending, setDeviceAuthPending] = useState(false);

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
        <div className="space-y-2">
          {providers.map((provider) => {
            const status = providerStatuses.find((entry) => entry.provider === provider.id)?.source ?? 'none';
            return (
              <div key={provider.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950">
                <span className="font-mono text-slate-700 dark:text-slate-200">{provider.id}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${status === 'none' ? 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                  {status}
                </span>
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
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            checked={useWorktree}
            className="h-4 w-4"
            onChange={(event) => setUseWorktree(event.target.checked)}
            type="checkbox"
          />
          Create a dedicated git worktree for each new run
        </label>
      </div>
    </div>
  );
}