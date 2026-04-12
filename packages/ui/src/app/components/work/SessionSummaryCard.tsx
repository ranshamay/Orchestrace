import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
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
  const latestTesterVerdictMessage = [...selectedSession.events]
    .reverse()
    .find((event) => event.type === 'task:tester-verdict')
    ?.message;
  const testerRejected = latestTesterVerdictMessage ? /rejected/i.test(latestTesterVerdictMessage) : false;
  const testerApproved = latestTesterVerdictMessage ? /approved/i.test(latestTesterVerdictMessage) : false;

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
        {(testerApproved || testerRejected) && (
          <span
            className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${
              testerRejected
                ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
            }`}
          >
            {testerRejected ? 'Tester Rejected' : 'Tester Approved'}
          </span>
        )}
      </div>
      {isTerminal && errorDetail && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorDetail}
        </div>
      )}
    </div>
  );
}