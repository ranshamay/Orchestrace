import type { ApprovalRequestMessagePart } from '../../../chat-types';

type Props = {
  part: ApprovalRequestMessagePart;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
};

export function ApprovalRequestPart({ part, onApprove, onReject }: Props) {
  const isPending = part.status === 'pending';

  return (
    <div className={`rounded-md border px-2.5 py-2 my-1 text-[11px] ${
      isPending
        ? 'border-amber-300 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/30 animate-pulse'
        : part.status === 'approved'
          ? 'border-emerald-300 bg-emerald-50/30 dark:border-emerald-700 dark:bg-emerald-950/20'
          : 'border-red-300 bg-red-50/30 dark:border-red-700 dark:bg-red-950/20'
    }`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span>✋</span>
        <span className="font-semibold text-slate-700 dark:text-slate-300">
          {isPending ? 'Plan ready for review' : part.status === 'approved' ? 'Plan approved' : 'Plan rejected'}
        </span>
      </div>
      {part.planSummary && (
        <p className="text-slate-600 dark:text-slate-400 mb-1.5 whitespace-pre-wrap">{part.planSummary}</p>
      )}
      {isPending && (
        <div className="flex items-center gap-2">
          <button
            onClick={onApprove}
            className="rounded bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-emerald-700 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={onReject}
            className="rounded bg-red-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-red-700 transition-colors"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
