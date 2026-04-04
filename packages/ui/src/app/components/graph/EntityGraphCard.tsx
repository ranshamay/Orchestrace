import { Loader2 } from 'lucide-react';
import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
import { compactPromptDisplay } from '../../utils/text';
import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { statusColor, formatSessionStatus, sessionStatusBadgeClass } from '../../utils/status';
import { buildGraphLayout } from '../../utils/graph';
import { isLlmStatusBusy, llmPhaseBadgeClass, llmPhaseLabel, llmStatusBadgeClass } from '../../utils/llm';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
  isDark: boolean;
};

export function EntityGraphCard({ selectedSession, selectedSessionRunning, selectedFailureType, selectedLlmStatus, isDark }: Props) {
  if (!selectedSession) {
    return <div className="text-center text-sm italic text-slate-400 dark:text-slate-500">Select a session to inspect its flow.</div>;
  }

  const graphLayout = buildGraphLayout(selectedSession);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Entity Graph</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {selectedSessionRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-500 dark:text-blue-300" />}
            <span>{compactPromptDisplay(selectedSession.prompt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(selectedSession.status)}`}>
            {formatSessionStatus(selectedSession.status)}
          </span>
          {selectedFailureType && (
            <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${failureTypeBadgeClass(selectedFailureType)}`}>
              {formatFailureTypeLabel(selectedFailureType)}
            </span>
          )}
          {selectedLlmStatus.phase && (
            <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(selectedLlmStatus.phase)}`}>
              {llmPhaseLabel(selectedLlmStatus.phase)}
            </span>
          )}
          <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${llmStatusBadgeClass(selectedLlmStatus)}`}>
            {selectedLlmStatus.label}
          </span>
          {isLlmStatusBusy(selectedLlmStatus) && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500 dark:text-blue-300" />}
        </div>
      </div>
      <div className="overflow-auto rounded border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
        <svg aria-label="Entity graph" className="block" height={graphLayout.height} role="img" width={graphLayout.width}>
          {graphLayout.nodes.flatMap((node) => node.dependencies.map((dep) => {
            const fromNode = graphLayout.nodes.find((candidate) => candidate.id === dep);
            if (!fromNode) {
              return null;
            }
            return (
              <line
                key={`edge-${dep}-${node.id}`}
                stroke={isDark ? '#475569' : '#94a3b8'}
                strokeWidth={2}
                x1={fromNode.x + 90}
                x2={node.x - 90}
                y1={fromNode.y}
                y2={node.y}
              />
            );
          }))}
          {graphLayout.nodes.map((node) => (
            <g key={node.id}>
              <rect
                fill={isDark ? '#0f172a' : 'white'}
                height={72}
                rx={12}
                stroke={statusColor(node.status)}
                strokeWidth={2}
                width={180}
                x={node.x - 90}
                y={node.y - 36}
              />
              <text fill={isDark ? '#e2e8f0' : '#0f172a'} fontSize={12} fontWeight={700} textAnchor="middle" x={node.x} y={node.y - 8}>
                {node.label}
              </text>
              <text fill={isDark ? '#94a3b8' : '#475569'} fontSize={10} textAnchor="middle" x={node.x} y={node.y + 10}>
                {node.status}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}