import { useEffect, useMemo, useRef } from 'react';
import type { ProviderInfo, Workspace } from '../../../lib/api';
import { ModelAutocomplete } from '../ModelAutocomplete';

export type LlmControlsModalProps = {
  isOpen: boolean;
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  workspaces: Workspace[];
  currentModels: string[];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  deliveryStrategy: 'pr-only' | 'merge-after-ci';
  autoApprove: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  onClose: () => void;
  onChangeWorkspace: (workspaceId: string) => void;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onChangeDeliveryStrategy: (next: 'pr-only' | 'merge-after-ci') => void;
  onChangeAutoApprove: (next: boolean) => void;
  onChangeAdaptiveConcurrency: (next: boolean) => void;
  onChangeBatchConcurrency: (next: number) => void;
  onChangeBatchMinConcurrency: (next: number) => void;
};

export function LlmControlsModal(props: LlmControlsModalProps) {
  const {
    isOpen,
    providers,
    providerStatuses,
    workspaces,
    currentModels,
    workWorkspaceId,
    workProvider,
    workModel,
    deliveryStrategy,
    autoApprove,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    onClose,
    onChangeWorkspace,
    onChangeProvider,
    onChangeModel,
    onChangeDeliveryStrategy,
    onChangeAutoApprove,
    onChangeAdaptiveConcurrency,
    onChangeBatchConcurrency,
    onChangeBatchMinConcurrency,
  } = props;

  const connectedProviders = useMemo(() => {
    const connectedProviderIds = new Set(
      providerStatuses.filter((entry) => entry.source !== 'none').map((entry) => entry.provider),
    );
    return providers.filter((provider) => connectedProviderIds.has(provider.id));
  }, [providerStatuses, providers]);

  const lastAutoProviderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      lastAutoProviderRef.current = null;
      return;
    }

    if (connectedProviders.length === 0) {
      if (workProvider && lastAutoProviderRef.current !== '') {
        lastAutoProviderRef.current = '';
        onChangeProvider('');
      }
      return;
    }

    if (connectedProviders.some((provider) => provider.id === workProvider)) {
      lastAutoProviderRef.current = workProvider;
      return;
    }

    const nextProvider = connectedProviders[0].id;
    if (lastAutoProviderRef.current === nextProvider) {
      return;
    }

    lastAutoProviderRef.current = nextProvider;
    onChangeProvider(nextProvider);
  }, [connectedProviders, isOpen, onChangeProvider, workProvider]);

  if (!isOpen) {
    return null;
  }

  return (
    <div aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" onClick={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Edit LLM Controls</h2>
          <button className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800" onClick={onClose} type="button">Close</button>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          <select className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" value={workWorkspaceId} onChange={(event) => onChangeWorkspace(event.target.value)}>
            <option value="">Workspace</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>

          <select className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" value={workProvider} onChange={(event) => onChangeProvider(event.target.value)}>
            <option value="">Provider</option>
            {connectedProviders.length === 0 && <option value="" disabled>No connected providers</option>}
            {connectedProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
          </select>

          <ModelAutocomplete
            models={currentModels}
            value={workModel}
            onChange={onChangeModel}
            placeholder="Search models…"
            className="md:col-span-2"
          />

          <label className="flex flex-col gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <span>Delivery strategy</span>
            <select
              className="rounded border border-slate-200 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
              value={deliveryStrategy}
              onChange={(event) => onChangeDeliveryStrategy(event.target.value === 'merge-after-ci' ? 'merge-after-ci' : 'pr-only')}
            >
              <option value="pr-only">Open PR after CI</option>
              <option value="merge-after-ci">Auto-merge after CI</option>
            </select>
            <span className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              PR-only keeps the pull request open after checks pass. Auto-merge waits for CI to pass, then merges using the standard merge method.
            </span>
          </label>

          <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <input checked={autoApprove} className="h-4 w-4" onChange={(event) => onChangeAutoApprove(event.target.checked)} type="checkbox" />
            Auto-approve
          </label>

          <div className="md:col-span-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
            Worktree mode: <span className="font-mono">native git worktree</span>
          </div>

          <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <input checked={adaptiveConcurrency} className="h-4 w-4" onChange={(event) => onChangeAdaptiveConcurrency(event.target.checked)} type="checkbox" />
            Adaptive tool concurrency
          </label>

          <label className="flex flex-col gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <span>Tool batch concurrency</span>
            <input
              className="rounded border border-slate-200 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
              min={1}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(value) && value > 0) {
                  onChangeBatchConcurrency(value);
                }
              }}
              type="number"
              value={batchConcurrency}
            />
          </label>

          <label className="flex flex-col gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <span>Tool min concurrency</span>
            <input
              className="rounded border border-slate-200 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
              min={1}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(value) && value > 0) {
                  onChangeBatchMinConcurrency(value);
                }
              }}
              type="number"
              value={batchMinConcurrency}
            />
          </label>
        </div>

        <div className="flex justify-end">
          <button className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  );
}