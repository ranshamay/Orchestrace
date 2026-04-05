import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
import { compactPromptDisplay } from '../../utils/text';
import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { formatSessionStatus, sessionStatusBadgeClass } from '../../utils/status';
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

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
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
  );
}