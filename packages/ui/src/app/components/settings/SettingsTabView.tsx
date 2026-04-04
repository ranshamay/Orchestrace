import { Settings } from 'lucide-react';
import type { ProviderInfo, Workspace } from '../../../lib/api';

type Props = {
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  useWorktree: boolean;
  setUseWorktree: (next: boolean) => void;
};

export function SettingsTabView({ providers, providerStatuses, workspaces, activeWorkspaceId, useWorktree, setUseWorktree }: Props) {
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