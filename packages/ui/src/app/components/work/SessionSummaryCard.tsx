import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
import { compactPromptDisplay } from '../../utils/text';
import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { formatSessionStatus, normalizeSessionStatus, sessionStatusBadgeClass } from '../../utils/status';
import { llmStatusBadgeClass } from '../../utils/llm';

type Props = {
  selectedSession?: WorkSession;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
};

export function SessionSummaryCard({ selectedSession, selectedFailureType, selectedLlmStatus }: Props) {
  if (!selectedSession) {
    return null;
  }

  const isTerminal = normalizeSessionStatus(selectedSession.status) === 'failed' || normalizeSessionStatus(selectedSession.status) === 'cancelled';
  const errorDetail = selectedSession.error || selectedLlmStatus.detail;

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(selectedSession.status)}`}>
          {formatSessionStatus(selectedSession.status)}
        </span>
        {selectedFailureType && (
          <span className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${failureTypeBadgeClass(selectedFailureType)}`}>
            {formatFailureTypeLabel(selectedFailureType)}
          </span>
        )}
        <span className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${llmStatusBadgeClass(selectedLlmStatus)}`}>
          {selectedLlmStatus.label}
        </span>
        <span className="truncate text-slate-500 dark:text-slate-400" title={selectedSession.prompt}>
          {compactPromptDisplay(selectedSession.prompt)}
        </span>
      </div>
      {isTerminal && errorDetail && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorDetail}
        </div>
      )}
    </div>
  );
}