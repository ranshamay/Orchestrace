import { Loader2 } from 'lucide-react';
import type { WorkSession } from '../../../lib/api';
import type { FailureType, GraphNodeView, LlmSessionStatus } from '../../types';
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

/* ── colour helpers ── */
const NODE_W = 260;
const NODE_H = 72;
const NODE_R = 14;

function statusGlow(status: string): string {
  switch (status) {
    case 'running': return '#3b82f6';
    case 'completed': return '#10b981';
    case 'failed': return '#ef4444';
    default: return 'transparent';
  }
}

function statusFill(status: string, isDark: boolean): string {
  switch (status) {
    case 'running': return isDark ? '#1e293b' : '#eff6ff';
    case 'completed': return isDark ? '#0f1d1a' : '#f0fdf4';
    case 'failed': return isDark ? '#1f1215' : '#fef2f2';
    default: return isDark ? '#0f172a' : '#ffffff';
  }
}

function statusIcon(status: string, isDark: boolean) {
  const cx = 0;
  const cy = 0;
  switch (status) {
    case 'running':
      return (
        <g className="graph-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          <circle cx={cx} cy={cy} fill="none" r={7} stroke="#3b82f6" strokeDasharray="14 28" strokeLinecap="round" strokeWidth={2.5} />
        </g>
      );
    case 'completed':
      return (
        <g>
          <circle cx={cx} cy={cy} fill="#10b981" r={8} />
          <path d={`M${cx - 4} ${cy} l2.5 3 5-5.5`} fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        </g>
      );
    case 'failed':
      return (
        <g>
          <circle cx={cx} cy={cy} fill="#ef4444" r={8} />
          <path d={`M${cx - 3.5} ${cy - 3.5} l7 7 M${cx + 3.5} ${cy - 3.5} l-7 7`} fill="none" stroke="white" strokeLinecap="round" strokeWidth={2} />
        </g>
      );
    default:
      return (
        <circle cx={cx} cy={cy} fill={isDark ? '#334155' : '#cbd5e1'} r={5} />
      );
  }
}

/* ── edge component ── */
function GraphEdge({ from, to, isDark }: { from: GraphNodeView; to: GraphNodeView; isDark: boolean }) {
  const x1 = from.x + NODE_W / 2;
  const x2 = to.x - NODE_W / 2;
  const y1 = from.y;
  const y2 = to.y;

  const active = from.status === 'completed' && to.status === 'running';
  const completed = from.status === 'completed' && to.status === 'completed';
  const midX1 = x1 + (x2 - x1) * 0.35;
  const midX2 = x1 + (x2 - x1) * 0.65;
  const d = `M${x1},${y1} C${midX1},${y1} ${midX2},${y2} ${x2},${y2}`;
  const pathId = `edge-${from.id}-${to.id}`;

  return (
    <g>
      {/* base edge */}
      <path
        d={d}
        fill="none"
        id={pathId}
        stroke={completed ? (isDark ? '#065f46' : '#86efac') : active ? '#3b82f6' : (isDark ? '#334155' : '#cbd5e1')}
        strokeLinecap="round"
        strokeWidth={active ? 2.5 : 2}
        {...(active ? { strokeDasharray: '6 4', className: 'graph-dash-flow' } : {})}
      />
      {/* flowing particle on active edge */}
      {active && (
        <>
          <circle fill="#3b82f6" r={3.5}>
            <animateMotion dur="1.5s" repeatCount="indefinite">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          <circle fill="#93c5fd" r={2}>
            <animateMotion begin="0.75s" dur="1.5s" repeatCount="indefinite">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
        </>
      )}
    </g>
  );
}

/* ── node component ── */
function GraphNode({ node, isDark, delay }: { node: GraphNodeView; isDark: boolean; delay: number }) {
  const x = node.x - NODE_W / 2;
  const y = node.y - NODE_H / 2;
  const isRunning = node.status === 'running';
  const glowColor = statusGlow(node.status);

  return (
    <g className="graph-node-enter" style={{ animationDelay: `${delay}ms` }}>
      {/* glow shadow for running / completed / failed */}
      {node.status !== 'pending' && (
        <rect
          className={isRunning ? 'graph-glow-breathe' : undefined}
          fill="none"
          filter={`url(#glow-${node.status})`}
          height={NODE_H + 8}
          rx={NODE_R + 2}
          stroke={glowColor}
          strokeWidth={4}
          width={NODE_W + 8}
          x={x - 4}
          y={y - 4}
        />
      )}

      {/* pulse ring for running nodes */}
      {isRunning && (
        <rect
          className="graph-pulse-ring"
          fill="none"
          height={NODE_H + 12}
          rx={NODE_R + 4}
          stroke="#3b82f6"
          strokeWidth={2}
          style={{ transformOrigin: `${node.x}px ${node.y}px` }}
          width={NODE_W + 12}
          x={x - 6}
          y={y - 6}
        />
      )}

      {/* main card */}
      <rect
        fill={statusFill(node.status, isDark)}
        height={NODE_H}
        rx={NODE_R}
        stroke={statusColor(node.status)}
        strokeWidth={2}
        style={{ transition: 'fill 0.4s ease, stroke 0.4s ease' }}
        width={NODE_W}
        x={x}
        y={y}
      />

      {/* status icon (left of label) */}
      <g transform={`translate(${x + 20}, ${node.y - 2})`}>
        {statusIcon(node.status, isDark)}
      </g>

      {/* label */}
      <text
        fill={isDark ? '#e2e8f0' : '#0f172a'}
        fontSize={12}
        fontWeight={700}
        textAnchor="start"
        x={x + 36}
        y={node.y - 6}
      >
        {node.label}
      </text>

      {/* status label */}
      <text
        fill={statusColor(node.status)}
        fontSize={10}
        fontWeight={600}
        textAnchor="start"
        x={x + 36}
        y={node.y + 12}
      >
        {node.status.toUpperCase()}
      </text>
    </g>
  );
}

/* ── SVG defs ── */
function GraphDefs() {
  return (
    <defs>
      <filter height="200%" id="glow-running" width="200%" x="-50%" y="-50%">
        <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="6" />
        <feComposite in="blur" in2="SourceGraphic" operator="over" />
      </filter>
      <filter height="200%" id="glow-completed" width="200%" x="-50%" y="-50%">
        <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="4" />
        <feComposite in="blur" in2="SourceGraphic" operator="over" />
      </filter>
      <filter height="200%" id="glow-failed" width="200%" x="-50%" y="-50%">
        <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="4" />
        <feComposite in="blur" in2="SourceGraphic" operator="over" />
      </filter>
    </defs>
  );
}

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
      <div className="overflow-auto rounded-lg border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
        <svg aria-label="Entity graph" className="block" height={graphLayout.height} role="img" width={graphLayout.width}>
          <GraphDefs />
          {/* edges first (below nodes) */}
          {graphLayout.nodes.flatMap((node) => node.dependencies.map((dep) => {
            const fromNode = graphLayout.nodes.find((c) => c.id === dep);
            if (!fromNode) return null;
            return <GraphEdge from={fromNode} isDark={isDark} key={`edge-${dep}-${node.id}`} to={node} />;
          }))}
          {/* nodes */}
          {graphLayout.nodes.map((node, i) => (
            <GraphNode delay={i * 60} isDark={isDark} key={node.id} node={node} />
          ))}
        </svg>
      </div>
    </div>
  );
}