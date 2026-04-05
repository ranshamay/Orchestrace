import { Loader2, Play } from 'lucide-react';
import type { ComposerImageAttachment, ComposerMode } from '../../types';
import { compactPromptDisplay } from '../../utils/text';
import { composerModeBadgeClass, composerModeDescription } from '../../utils/composer';
import type { GitWorktreeInfo, WorkSession, Workspace } from '../../../lib/api';
import { normalizeSessionStatus } from '../../utils/status';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionId: string;
  selectedSessionRunning: boolean;
  composerMode: ComposerMode;
  workspaces: Workspace[];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  executionContext: 'workspace' | 'git-worktree';
  selectedWorktreePath: string;
  availableWorktrees: GitWorktreeInfo[];
  useWorktree: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: ComposerImageAttachment[];
  removeComposerAttachment: (id: string) => void;
  hasComposerContent: boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  onStartFromComposer: () => Promise<void>;
  onStop: () => Promise<void>;
  onSendChat: () => Promise<void>;
};

export function ComposerPanel(props: Props) {
  const {
    selectedSession,
    selectedSessionId,
    selectedSessionRunning,
    composerMode,
    workspaces,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    executionContext,
    selectedWorktreePath,
    availableWorktrees,
    useWorktree,
    composerText,
    setComposerText,
    composerImages,
    removeComposerAttachment,
    hasComposerContent,
    onComposerPaste,
    onStartFromComposer,
    onStop,
    onSendChat,
  } = props;

  return (
    <div className="border-t border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 grid grid-cols-2 gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
        <div className="truncate">Workspace: <span className="font-mono">{workspaces.find((workspace) => workspace.id === workWorkspaceId)?.name ?? 'none'}</span></div>
        <div className="truncate">Provider: <span className="font-mono">{workProvider || 'none'}</span></div>
        <div className="truncate">Model: <span className="font-mono">{workModel || 'none'}</span></div>
        <div>Auto-approve: <span className="font-mono">{autoApprove ? 'on' : 'off'}</span></div>
        <div>Execution: <span className="font-mono">{executionContext}</span></div>
        <div className="col-span-2 truncate">Worktree path: <span className="font-mono">{selectedWorktreePath || (executionContext === 'git-worktree' ? 'auto-select' : 'n/a')}</span></div>
        {executionContext === 'git-worktree' && availableWorktrees.length === 0 && (
          <div className="col-span-2 text-amber-700 dark:text-amber-300">No secondary git worktrees discovered for this workspace.</div>
        )}
        {executionContext === 'git-worktree' && useWorktree === false && (
          <div className="col-span-2 text-amber-700 dark:text-amber-300">Legacy useWorktree flag is off; context still controls execution target.</div>
        )}
      </div>
      {selectedSession && (
        <div className="mb-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200">
          <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Original ask kept in context</div>
          <div className="mt-1 line-clamp-2">{compactPromptDisplay(selectedSession.prompt)}</div>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] dark:border-slate-700 dark:bg-slate-900">
        <div className="text-slate-600 dark:text-slate-300">Composer mode: <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${composerModeBadgeClass(composerMode)}`}>{composerMode}</span></div>
        <div className="text-[10px] text-slate-500 dark:text-slate-400">{composerModeDescription(composerMode)}</div>
      </div>
      {selectedSessionRunning && (
        <div className="mb-2 flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Agent is actively working. Follow progress in the timeline and graph.</span>
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          className="h-14 flex-1 resize-none rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          onChange={(event) => setComposerText(event.target.value)}
          onPaste={(event) => {
            void onComposerPaste(event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (selectedSessionId) {
                void onSendChat();
              } else {
                void onStartFromComposer();
              }
            }
          }}
          placeholder={selectedSessionId ? 'Continue in this session context...' : 'Describe task and start autonomous execution...'}
          value={composerText}
        />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={!hasComposerContent || !workWorkspaceId || !workProvider || !workModel} onClick={() => { void onStartFromComposer(); }} type="button"><Play className="h-3 w-3" /> {selectedSessionId ? 'Continue' : 'Run'}</button>
            <button className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={!selectedSessionId || !selectedSession || normalizeSessionStatus(selectedSession.status) !== 'running'} onClick={() => { void onStop(); }} type="button">Stop</button>
          </div>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-700" disabled={!hasComposerContent || !workWorkspaceId || !workProvider || !workModel} onClick={() => { void onSendChat(); }} type="button">Autonomous Run</button>
        </div>
      </div>
      {composerImages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {composerImages.map((attachment) => (
            <div key={attachment.id} className="group relative overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <img alt={attachment.name} className="h-16 w-16 object-cover" src={attachment.dataUrl} />
              <button aria-label={`Remove ${attachment.name}`} className="absolute right-1 top-1 rounded bg-slate-900/70 px-1 text-[10px] text-white" onClick={() => removeComposerAttachment(attachment.id)} type="button">x</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}