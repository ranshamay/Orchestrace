import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
import { compactPromptDisplay } from '../../utils/text';
import { buildRunDeepLink } from '../../utils/runUrl';
import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { formatSessionStatus, sessionStatusBadgeClass } from '../../utils/status';
import { llmPhaseBadgeClass, llmPhaseLabel, llmStatusBadgeClass } from '../../utils/llm';

type Props = {
  selectedSession?: WorkSession;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
};

export function SessionSummaryCard({ selectedSession, selectedFailureType, selectedLlmStatus }: Props) {
  if (!selectedSession) {
    return (
      <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
        Select a run to inspect provider, model, and timeline details.
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="line-clamp-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{compactPromptDisplay(selectedSession.prompt)}</div>
        <div className="flex items-center gap-1.5">
          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(selectedSession.status)}`}>
            {formatSessionStatus(selectedSession.status)}
          </span>
          {selectedFailureType && (
            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${failureTypeBadgeClass(selectedFailureType)}`}>
              {formatFailureTypeLabel(selectedFailureType)}
            </span>
          )}
          {selectedLlmStatus.phase && (
            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(selectedLlmStatus.phase)}`}>
              {llmPhaseLabel(selectedLlmStatus.phase)}
            </span>
          )}
          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${llmStatusBadgeClass(selectedLlmStatus)}`}>
            {selectedLlmStatus.label}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
        <div>Provider: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.provider}</span></div>
        <div>Model: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.model}</span></div>
        <div className="md:col-span-2">Run ID: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.id}</span></div>
        <div className="md:col-span-2">
          LLM status: <span className="font-semibold text-slate-700 dark:text-slate-200">{selectedLlmStatus.label}</span>
          {selectedLlmStatus.detail ? ` - ${selectedLlmStatus.detail}` : ''}
        </div>
        <div>Run phase: <span className="font-semibold text-slate-700 dark:text-slate-200">{llmPhaseLabel(selectedLlmStatus.phase)}</span></div>
        <div className="truncate md:col-span-2">
          Deep link:{' '}
          <a className="font-mono text-blue-600 underline decoration-blue-300 underline-offset-2 dark:text-blue-300" href={buildRunDeepLink(selectedSession.id)}>
            {buildRunDeepLink(selectedSession.id)}
          </a>
        </div>
      </div>
    </div>
  );
}