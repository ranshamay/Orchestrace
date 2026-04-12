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
  const latestTesterVerdict = [...selectedSession.events]
    .reverse()
    .find((event) => event.type === 'task:tester-verdict');
  const latestTesterVerdictMessage = latestTesterVerdict?.message;
  const testerRejected = latestTesterVerdict
    ? latestTesterVerdict.testsFailed !== undefined
      ? latestTesterVerdict.testsFailed > 0
      : /rejected/i.test(latestTesterVerdictMessage ?? '')
    : false;
  const testerApproved = latestTesterVerdict
    ? latestTesterVerdict.testsFailed !== undefined
      ? latestTesterVerdict.testsFailed === 0
      : /approved/i.test(latestTesterVerdictMessage ?? '')
    : false;
  const testerPlan = latestTesterVerdict?.testPlan ?? [];
  const testerCommands = latestTesterVerdict?.executedTestCommands ?? [];
  const testerScreenshots = latestTesterVerdict?.screenshotPaths ?? [];

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

      {latestTesterVerdict && (
        <div className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Tested Summary
          </div>
          <div className="space-y-0.5">
            <div>
              Tests: passed={latestTesterVerdict.testsPassed ?? 0} failed={latestTesterVerdict.testsFailed ?? 0}
            </div>
            {latestTesterVerdict.coverageAssessment && (
              <div>Coverage: {latestTesterVerdict.coverageAssessment}</div>
            )}
            {latestTesterVerdict.qualityAssessment && (
              <div>Quality: {latestTesterVerdict.qualityAssessment}</div>
            )}
            {testerPlan.length > 0 && (
              <div>Plan: {testerPlan.slice(0, 4).join(' | ')}</div>
            )}
            {testerCommands.length > 0 && (
              <div>Commands: {testerCommands.slice(0, 3).join(' | ')}</div>
            )}
            {(latestTesterVerdict.uiTestsRequired || latestTesterVerdict.uiChangesDetected) && (
              <div>
                UI: required={latestTesterVerdict.uiTestsRequired ? 'yes' : 'no'} run={latestTesterVerdict.uiTestsRun ? 'yes' : 'no'} screenshots={testerScreenshots.length}
              </div>
            )}
            {testerScreenshots.length > 0 && (
              <div>
                <div className="mb-0.5">Screenshots ({testerScreenshots.length}):</div>
                <div className="flex flex-wrap gap-1.5">
                  {testerScreenshots.slice(0, 6).map((screenshotPath, i) => (
                    <a
                      key={i}
                      href={`/api/work/screenshot?id=${encodeURIComponent(selectedSession.id)}&path=${encodeURIComponent(screenshotPath)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <img
                        src={`/api/work/screenshot?id=${encodeURIComponent(selectedSession.id)}&path=${encodeURIComponent(screenshotPath)}`}
                        alt={`Screenshot ${i + 1}`}
                        className="h-20 max-w-[160px] rounded border border-slate-300 object-cover dark:border-slate-600"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {latestTesterVerdict.rejectionReason && (
              <div>Reason: {latestTesterVerdict.rejectionReason}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}