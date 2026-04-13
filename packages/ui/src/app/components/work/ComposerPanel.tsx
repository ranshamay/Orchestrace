import { Check, Play, Square, X } from 'lucide-react';
import type { ComposerImageAttachment, ComposerMode, LlmSessionStatus } from '../../types';
import type { WorkSession, Workspace } from '../../../lib/api';
import { normalizeSessionStatus } from '../../utils/status';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionId: string;
  selectedSessionRunning: boolean;
  selectedLlmStatus: LlmSessionStatus;
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
  onStop: () => Promise<void>;
  onApprovePlan: () => Promise<void>;
  onRejectPlan: () => Promise<void>;
  onSendChat: () => Promise<void>;
};

export function ComposerPanel(props: Props) {
  const {
    selectedSession,
    selectedSessionId,
    selectedLlmStatus,
    workWorkspaceId,
    workProvider,
    workModel,
    composerText,
    setComposerText,
    composerImages,
    removeComposerAttachment,
    hasComposerContent,
    onComposerPaste,
    onStop,
    onApprovePlan,
    onRejectPlan,
    onSendChat,
  } = props;

  const normalizedSessionStatus = selectedSession ? normalizeSessionStatus(selectedSession.status) : 'unknown';
  const awaitingPlanApproval = Boolean(
    selectedSessionId
      && selectedSession
      && selectedLlmStatus.state === 'awaiting-approval',
  );

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
              void onSendChat();
            }
          }}
          placeholder={selectedSessionId ? 'Continue autonomously from this run context and start a new execution...' : 'Describe task and start autonomous execution...'}
          value={composerText}
        />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              aria-label="Run"
              className="inline-flex items-center rounded bg-blue-600 p-2 text-white disabled:opacity-50"
              disabled={!hasComposerContent || (!selectedSessionId && (!workWorkspaceId || !workProvider || !workModel)) || awaitingPlanApproval}
              onClick={() => {
                void onSendChat();
              }}
              title="Run"
              type="button"
            >
              <Play className="h-4 w-4" />
            </button>
            <button
              aria-label="Stop"
              className="inline-flex items-center rounded bg-red-600 p-2 text-white disabled:opacity-50"
              disabled={!selectedSessionId || !selectedSession || (normalizedSessionStatus !== 'running' && normalizedSessionStatus !== 'idle')}
              onClick={() => {
                void onStop();
              }}
              title="Stop"
              type="button"
            >
              <Square className="h-4 w-4" />
            </button>
          </div>
          {awaitingPlanApproval && (
            <div className="flex gap-2">
              <button
                aria-label="Approve plan"
                className="inline-flex items-center rounded bg-emerald-600 p-2 text-white disabled:opacity-50"
                disabled={!selectedSessionId}
                onClick={() => {
                  void onApprovePlan();
                }}
                title="Approve plan"
                type="button"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                aria-label="Reject plan"
                className="inline-flex items-center rounded bg-amber-600 p-2 text-white disabled:opacity-50"
                disabled={!selectedSessionId}
                onClick={() => {
                  void onRejectPlan();
                }}
                title="Reject plan"
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
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