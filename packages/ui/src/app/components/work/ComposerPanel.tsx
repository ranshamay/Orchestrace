import { Loader2, Play, Square } from 'lucide-react';
import type { ComposerImageAttachment, ComposerMode } from '../../types';
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
  onRun: () => Promise<void>;
  onStop: () => Promise<void>;
};

export function ComposerPanel(props: Props) {
  const {
    selectedSession,
    selectedSessionId,
    selectedSessionRunning,
    workWorkspaceId,
    workProvider,
    workModel,
    composerText,
    setComposerText,
    composerImages,
    removeComposerAttachment,
    hasComposerContent,
    onComposerPaste,
    onRun,
    onStop,
  } = props;

  return (
    <div className="border-t border-slate-200/60 bg-white/80 p-2 dark:border-slate-800/60 dark:bg-slate-900/80">
      {selectedSessionRunning && (
        <div className="mb-1.5 flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Working...</span>
        </div>
      )}
      <div className="flex gap-1.5">
        <textarea
          className="h-10 flex-1 resize-none rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1.5 text-sm placeholder:text-slate-400 dark:border-slate-700/80 dark:bg-slate-800 dark:placeholder:text-slate-500"
          onChange={(event) => setComposerText(event.target.value)}
          onPaste={(event) => {
            void onComposerPaste(event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void onRun();
            }
          }}
          placeholder={selectedSessionId ? 'Continue...' : 'Describe task...'}
          value={composerText}
        />
        <div className="flex flex-col gap-1">
          <button
            aria-label="Run"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white disabled:opacity-40 hover:bg-blue-500"
            disabled={!hasComposerContent || !workWorkspaceId || !workProvider || !workModel}
            onClick={() => { void onRun(); }}
            title="Run"
            type="button"
          >
            <Play className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Stop"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-white disabled:opacity-40 hover:bg-red-500"
            disabled={!selectedSessionId || !selectedSession || normalizeSessionStatus(selectedSession.status) !== 'running'}
            onClick={() => { void onStop(); }}
            title="Stop"
            type="button"
          >
            <Square className="h-3 w-3" />
          </button>
        </div>
      </div>
      {composerImages.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {composerImages.map((attachment) => (
            <div key={attachment.id} className="group relative overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <img alt={attachment.name} className="h-12 w-12 object-cover" src={attachment.dataUrl} />
              <button aria-label={`Remove ${attachment.name}`} className="absolute right-0.5 top-0.5 rounded bg-slate-900/70 px-1 text-[9px] text-white" onClick={() => removeComposerAttachment(attachment.id)} type="button">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}