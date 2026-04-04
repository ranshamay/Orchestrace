import type { ProviderInfo, Workspace } from '../../../lib/api';

export type LlmControlsModalProps = {
  isOpen: boolean;
  providers: ProviderInfo[];
  workspaces: Workspace[];
  currentModels: string[];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  useWorktree: boolean;
  onClose: () => void;
  onChangeWorkspace: (workspaceId: string) => void;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onChangeAutoApprove: (next: boolean) => void;
  onChangeUseWorktree: (next: boolean) => void;
};

export function LlmControlsModal(props: LlmControlsModalProps) {
  const {
    isOpen,
    providers,
    workspaces,
    currentModels,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    useWorktree,
    onClose,
    onChangeWorkspace,
    onChangeProvider,
    onChangeModel,
    onChangeAutoApprove,
    onChangeUseWorktree,
  } = props;

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
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
          </select>

          <select className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 md:col-span-2" value={workModel} onChange={(event) => onChangeModel(event.target.value)}>
            <option value="">Model</option>
            {currentModels.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>

          <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <input checked={autoApprove} className="h-4 w-4" onChange={(event) => onChangeAutoApprove(event.target.checked)} type="checkbox" />
            Auto-approve
          </label>

          <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <input checked={useWorktree} className="h-4 w-4" onChange={(event) => onChangeUseWorktree(event.target.checked)} type="checkbox" />
            Use worktree for new runs
          </label>
        </div>

        <div className="flex justify-end">
          <button className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  );
}