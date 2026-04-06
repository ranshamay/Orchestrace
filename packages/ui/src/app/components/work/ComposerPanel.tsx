import { Play } from 'lucide-react';
import type { ComposerImageAttachment, ComposerMode } from '../../types';
import type { WorkSession, Workspace } from '../../../lib/api';
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
    workWorkspaceId,
    workProvider,
    workModel,
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
          placeholder={selectedSessionId ? 'Continue autonomously from this run context and start a new execution...' : 'Describe task and start autonomous execution...'}
          value={composerText}
        />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={!hasComposerContent || !workWorkspaceId || !workProvider || !workModel} onClick={() => { void onStartFromComposer(); }} type="button"><Play className="h-3 w-3" /> Run</button>
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