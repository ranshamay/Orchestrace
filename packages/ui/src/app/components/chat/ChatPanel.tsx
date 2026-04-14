import { useRef, useEffect, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ChatMessage, ToolCallMessagePart } from '../../chat-types';
import { PHASE_ICON, resolveToolIcon } from '../../chat-types';
import { MarkdownMessage } from '../MarkdownMessage';
import { ChevronDown, ChevronRight, Brain, AlertTriangle, Eye, Zap, ClipboardCopy, Check, Info, FileText, X } from 'lucide-react';
import { composerModeBadgeClass } from '../../utils/composer';
import type { ComposerMode } from '../../types';
import { fetchWorkPlan, type WorkSession, type Workspace } from '../../../lib/api';

type Props = {
  messages: ChatMessage[];
  isStreaming: boolean;
  activeMessageId: string | null;
  firstTokenLatencyMs: number | null;
  waitingForFirstToken: boolean;
  activeToolCalls: number;
  composer: ReactNode;
  onApprovePlan: () => Promise<void>;
  onRejectPlan: () => Promise<void>;
  isDark: boolean;
  sessionId?: string;
  selectedSession?: WorkSession;
  sessionPrompt?: string;
  sessionStatus?: string;
  sessionModel?: string;
  sessionProvider?: string;
  composerMode: ComposerMode;
  workspaces: Workspace[];
  workWorkspaceId: string;
  planningNoToolGuardMode: 'enforce' | 'warn';
  autoApprove: boolean;
  planningProvider: string;
  planningModel: string;
};

function formatLatency(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export function ChatPanel({ messages, isStreaming, activeMessageId: _activeMessageId, firstTokenLatencyMs, waitingForFirstToken, activeToolCalls, composer, onApprovePlan, onRejectPlan, isDark, sessionId, selectedSession, sessionPrompt, sessionStatus, sessionModel, sessionProvider, composerMode, workspaces, workWorkspaceId, planningNoToolGuardMode, autoApprove, planningProvider, planningModel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [showInfo, setShowInfo] = useState(false);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [loadedPlanKey, setLoadedPlanKey] = useState('');
  const [loadedPlanPath, setLoadedPlanPath] = useState('');
  const [planContent, setPlanContent] = useState('');
  const [planError, setPlanError] = useState('');

  const latestPlanPathFromEvents = useMemo(() => {
    if (!selectedSession) {
      return '';
    }

    for (let index = selectedSession.events.length - 1; index >= 0; index -= 1) {
      const event = selectedSession.events[index];
      if (event.type !== 'task:plan-persisted') {
        continue;
      }

      const planPath = event.planPath?.trim();
      if (planPath) {
        return planPath;
      }
    }

    return '';
  }, [selectedSession]);

  const availablePlanPath = selectedSession?.output?.planPath?.trim() || latestPlanPathFromEvents;
  const canViewPlan = Boolean(selectedSession?.id && availablePlanPath);

  const handleCopyInvestigation = useCallback(async () => {
    const prompt = buildInvestigationPrompt(messages, { sessionId, prompt: sessionPrompt, status: sessionStatus, model: sessionModel, provider: sessionProvider });
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch { /* ignore */ }
  }, [messages, sessionId, sessionPrompt, sessionStatus, sessionModel, sessionProvider]);

  const handleOpenPlanModal = useCallback(async () => {
    if (!selectedSession?.id || !availablePlanPath) {
      return;
    }

    setIsPlanModalOpen(true);
    const planKey = `${selectedSession.id}:${availablePlanPath}`;
    if (loadedPlanKey === planKey && planContent.length > 0) {
      return;
    }

    setIsPlanLoading(true);
    setPlanError('');

    try {
      const response = await fetchWorkPlan(selectedSession.id, availablePlanPath);
      setLoadedPlanKey(planKey);
      setLoadedPlanPath(response.planPath);
      setPlanContent(response.content);
    } catch (error) {
      setLoadedPlanPath(availablePlanPath);
      setPlanContent('');
      setPlanError(error instanceof Error ? error.message : 'Failed to load plan.');
    } finally {
      setIsPlanLoading(false);
    }
  }, [availablePlanPath, loadedPlanKey, planContent.length, selectedSession?.id]);

  useEffect(() => {
    if (!isPlanModalOpen || typeof window === 'undefined') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPlanModalOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isPlanModalOpen]);

  useEffect(() => {
    if (!isAutoScrollingRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAutoScrollingRef.current = dist < 80;
    setShowJump(dist > 200);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (el) { el.scrollTop = el.scrollHeight; isAutoScrollingRef.current = true; setShowJump(false); }
  }, []);

  const entries = buildStreamEntries(messages);

  const livePhase = (composerMode === 'planning' || composerMode === 'implementation' || composerMode === 'chat')
    ? composerMode
    : undefined;
  const displayModel = livePhase === 'planning' ? (planningModel || sessionModel) : (sessionModel || planningModel);
  const displayProvider = livePhase === 'planning' ? (planningProvider || sessionProvider) : (sessionProvider || planningProvider);
  const effectivePlanningGuard = planningNoToolGuardMode;
  const workspaceName = workspaces.find((w) => w.id === workWorkspaceId)?.name ?? 'none';

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Top bar: model + mode + info + copy trace */}
      <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-700/60 px-3 py-1.5 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300 truncate" title={`${displayProvider || ''}/${displayModel || ''}`}>
            {displayModel || 'no model'}
          </span>
          {isStreaming && <span className="text-[10px] text-violet-500 animate-pulse shrink-0">streaming</span>}
          {waitingForFirstToken && (
            <span className="text-[10px] text-amber-500 animate-pulse shrink-0">first token...</span>
          )}
          {activeToolCalls > 0 && (
            <span className="text-[10px] text-sky-500 shrink-0">using tools ({activeToolCalls})</span>
          )}
          {firstTokenLatencyMs !== null && (
            <span className="text-[10px] text-slate-500 dark:text-slate-400 shrink-0" title="Time to first token">
              ttft {formatLatency(firstTokenLatencyMs)}
            </span>
          )}
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${composerModeBadgeClass(composerMode)}`}>
            {composerMode}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canViewPlan && (
            <button
              onClick={handleOpenPlanModal}
              className="flex items-center rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="View plan"
              type="button"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="flex items-center rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Session info"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
            {showInfo && (
              <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800 p-3 text-xs text-slate-600 dark:text-slate-300 space-y-1.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Session Info</span>
                  <button onClick={() => setShowInfo(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="truncate">Workspace: <span className="font-mono">{workspaceName}</span></div>
                <div className="truncate">Provider: <span className="font-mono">{displayProvider || 'none'}</span></div>
                <div className="truncate">Model: <span className="font-mono">{displayModel || 'none'}</span></div>
                <div>Auto-approve: <span className="font-mono">{autoApprove ? 'on' : 'off'}</span></div>
                <div>Planning guard: <span className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${effectivePlanningGuard === 'warn' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>{effectivePlanningGuard}</span></div>
              </div>
            )}
          </div>
          {messages.length > 0 && (
            <button
              onClick={handleCopyInvestigation}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Copy session trace as LLM investigation prompt"
            >
              {copyState === 'copied' ? <Check className="h-3 w-3 text-emerald-500" /> : <ClipboardCopy className="h-3 w-3" />}
              <span>{copyState === 'copied' ? 'Copied' : 'Copy trace'}</span>
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="px-3 py-4 space-y-0">
          {entries.length === 0 && (
            <div className="flex items-center justify-center h-40 text-sm text-slate-400 dark:text-slate-500">
              No messages yet
            </div>
          )}
          {entries.map((entry, i) => (
            <StreamEntry
              key={entry.key}
              entry={entry}
              isDark={isDark}
              onApprovePlan={onApprovePlan}
              onRejectPlan={onRejectPlan}
              isLast={i === entries.length - 1}
            />
          ))}
        </div>
      </div>

      {showJump && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1.5 text-xs text-white shadow-lg hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-300 transition-colors"
        >
          <ChevronDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}

      <div className="border-t border-slate-200/60 dark:border-slate-700/60 bg-white dark:bg-slate-900">
        <div className="px-3">
          {composer}
        </div>
      </div>
      </div>

      {isPlanModalOpen && (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsPlanModalOpen(false);
            }
          }}
        >
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700">
              <div>
                <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Execution Plan</h2>
                {loadedPlanPath && (
                  <p className="max-w-[70vw] truncate text-[11px] text-slate-500 dark:text-slate-400" title={loadedPlanPath}>
                    {loadedPlanPath}
                  </p>
                )}
              </div>
              <button
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                onClick={() => setIsPlanModalOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {isPlanLoading ? (
                <div className="text-sm text-slate-500 dark:text-slate-400">Loading plan...</div>
              ) : planError ? (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  {planError}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-3 text-[12px] leading-5 text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                  {planContent || 'Plan file is empty.'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Stream entries ─────────────────────────────────────────────────────────

type StreamEntryData =
  | { kind: 'user-message'; key: string; text: string }
  | { kind: 'phase-divider'; key: string; phase: string; label: string; model?: string }
  | { kind: 'reasoning'; key: string; text: string; isStreaming: boolean }
  | { kind: 'text'; key: string; text: string; isStreaming: boolean }
  | { kind: 'tool-call'; key: string; part: ToolCallMessagePart }
  | { kind: 'tool-group'; key: string; tools: ToolCallMessagePart[] }
  | { kind: 'context-snapshot'; key: string; model: string; chars: number; images: number }
  | { kind: 'approval'; key: string; summary: string; status: 'pending' | 'approved' | 'rejected' }
  | { kind: 'observer-finding'; key: string; severity: string; title: string; detail?: string }
  | { kind: 'error'; key: string; message: string; detail?: string }
  | { kind: 'assistant-label'; key: string; agentId?: string; model?: string; phase?: string };

function buildStreamEntries(messages: ChatMessage[]): StreamEntryData[] {
  const entries: StreamEntryData[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      if (text) entries.push({ kind: 'user-message', key: `user-${msg.id}`, text });
      continue;
    }

    if (msg.role === 'system' && msg.parts.length === 1 && msg.parts[0].type === 'phase-transition') {
      const pt = msg.parts[0];
      entries.push({ kind: 'phase-divider', key: `phase-${msg.id}`, phase: pt.phase, label: pt.label, model: msg.metadata?.model });
      continue;
    }

    if (msg.role === 'assistant') {
      entries.push({
        kind: 'assistant-label',
        key: `label-${msg.id}`,
        agentId: msg.agentId,
        model: msg.metadata?.model,
        phase: msg.phase,
      });
    }

    let pendingTools: ToolCallMessagePart[] = [];
    const flushTools = () => {
      if (pendingTools.length === 0) return;
      if (pendingTools.length === 1) {
        entries.push({ kind: 'tool-call', key: `tool-${msg.id}-${pendingTools[0].id}`, part: pendingTools[0] });
      } else {
        entries.push({ kind: 'tool-group', key: `tg-${msg.id}-${pendingTools[0].id}-${pendingTools.length}`, tools: [...pendingTools] });
      }
      pendingTools = [];
    };

    for (const [partIndex, part] of msg.parts.entries()) {
      if (part.type === 'tool-call') {
        pendingTools.push(part);
        continue;
      }
      flushTools();

      switch (part.type) {
        case 'reasoning':
          entries.push({ kind: 'reasoning', key: `r-${msg.id}-${part.id}-${partIndex}`, text: part.text, isStreaming: part.isStreaming });
          break;
        case 'text':
          entries.push({ kind: 'text', key: `t-${msg.id}-${part.id}-${partIndex}`, text: part.text, isStreaming: part.isStreaming });
          break;
        case 'phase-transition':
          entries.push({ kind: 'phase-divider', key: `pt-${msg.id}-${part.phase}-${partIndex}`, phase: part.phase, label: part.label });
          break;
        case 'context-snapshot':
          entries.push({ kind: 'context-snapshot', key: `ctx-${msg.id}-${part.snapshotId}-${partIndex}`, model: part.model, chars: part.textChars, images: part.imageCount });
          break;
        case 'approval-request':
          entries.push({ kind: 'approval', key: `appr-${msg.id}-${partIndex}`, summary: part.planSummary, status: part.status });
          break;
        case 'observer-finding':
          entries.push({ kind: 'observer-finding', key: `obs-${msg.id}-${part.findingId}-${partIndex}`, severity: part.severity, title: part.title, detail: part.detail });
          break;
        case 'error':
          entries.push({ kind: 'error', key: `err-${msg.id}-${partIndex}`, message: part.message, detail: part.detail });
          break;
      }
    }
    flushTools();
  }

  return entries;
}

// ─── Entry renderers ────────────────────────────────────────────────────────

function StreamEntry({ entry, isDark, onApprovePlan, onRejectPlan, isLast }: {
  entry: StreamEntryData;
  isDark: boolean;
  onApprovePlan: () => Promise<void>;
  onRejectPlan: () => Promise<void>;
  isLast: boolean;
}) {
  switch (entry.kind) {
    case 'user-message':
      return <UserMessage text={entry.text} />;
    case 'phase-divider':
      return <PhaseDivider phase={entry.phase} label={entry.label} model={entry.model} />;
    case 'assistant-label':
      return <AssistantLabel agentId={entry.agentId} model={entry.model} phase={entry.phase} />;
    case 'reasoning':
      return <ReasoningBlock text={entry.text} isStreaming={entry.isStreaming} />;
    case 'text':
      return <TextBlock text={entry.text} isStreaming={entry.isStreaming} isDark={isDark} isLast={isLast} />;
    case 'tool-call':
      return <ToolCallChip part={entry.part} />;
    case 'tool-group':
      return <ToolGroup tools={entry.tools} />;
    case 'context-snapshot':
      return <ContextBadge model={entry.model} chars={entry.chars} images={entry.images} />;
    case 'approval':
      return <ApprovalCard summary={entry.summary} status={entry.status} onApprove={onApprovePlan} onReject={onRejectPlan} />;
    case 'observer-finding':
      return <ObserverFinding severity={entry.severity} title={entry.title} detail={entry.detail} />;
    case 'error':
      return <ErrorBlock message={entry.message} detail={entry.detail} />;
    default:
      return null;
  }
}

// ─── User message ───────────────────────────────────────────────────────────

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-[13px] text-white leading-relaxed shadow-sm whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

// ─── Assistant label ────────────────────────────────────────────────────────

function AssistantLabel({ agentId, model, phase }: { agentId?: string; model?: string; phase?: string }) {
  const phaseIcon = phase ? PHASE_ICON[phase] : null;
  return (
    <div className="flex items-center gap-1.5 pt-4 pb-1">
      <Zap className="h-3 w-3 text-violet-500" />
      {agentId && (
        <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
          {agentId}
        </span>
      )}
      {phaseIcon && <span className="text-[10px]">{phaseIcon}</span>}
      {model && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          {model}
        </span>
      )}
    </div>
  );
}

// ─── Phase divider ──────────────────────────────────────────────────────────

function PhaseDivider({ phase, label, model }: { phase: string; label: string; model?: string }) {
  const icon = PHASE_ICON[phase] ?? '📋';
  return (
    <div className="flex items-center gap-3 py-3 my-1">
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent dark:via-slate-600" />
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
        <span>{icon}</span>
        <span>{label}</span>
        {model && <span className="font-normal text-slate-400 dark:text-slate-500">· {model}</span>}
      </span>
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent dark:via-slate-600" />
    </div>
  );
}

// ─── Reasoning (inline, subtle) ─────────────────────────────────────────────

function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [collapsed, setCollapsed] = useState(!isStreaming && text.length > 300);
  const canCollapse = !isStreaming && text.length > 300;
  const lines = text.split('\n');
  const preview = collapsed ? lines.slice(0, 3).join('\n') : text;

  return (
    <div className="py-1">
      <button
        onClick={() => canCollapse && setCollapsed(!collapsed)}
        className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 mb-0.5"
      >
        <Brain className="h-3 w-3" />
        <span className="font-medium">
          {isStreaming ? 'Thinking…' : `Reasoning (${text.length.toLocaleString()} chars)`}
        </span>
        {canCollapse && (
          collapsed
            ? <ChevronRight className="h-2.5 w-2.5" />
            : <ChevronDown className="h-2.5 w-2.5" />
        )}
      </button>
      <div className="pl-4 border-l-2 border-slate-200 dark:border-slate-700 text-[12px] text-slate-500 dark:text-slate-400 italic leading-relaxed max-h-60 overflow-y-auto">
        <MarkdownMessage content={preview} dark={false} />
        {collapsed && '…'}
        {isStreaming && <span className="not-italic animate-pulse text-violet-400">▍</span>}
      </div>
    </div>
  );
}

// ─── Text (markdown) ────────────────────────────────────────────────────────

function TextBlock({ text, isStreaming, isDark, isLast }: { text: string; isStreaming: boolean; isDark: boolean; isLast: boolean }) {
  if (!text && !isStreaming) return null;
  return (
    <div className="py-0.5 text-[13px] leading-relaxed text-slate-800 dark:text-slate-200">
      <MarkdownMessage content={text} dark={isDark} />
      {isStreaming && isLast && <span className="animate-pulse text-violet-500">▍</span>}
    </div>
  );
}

// ─── Tool call chip ─────────────────────────────────────────────────────────

function ToolCallChip({ part }: { part: ToolCallMessagePart }) {
  const [expanded, setExpanded] = useState(false);
  const icon = resolveToolIcon(part.toolName);
  const isActive = part.status === 'calling';
  const statusColor =
    part.status === 'success' ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30' :
    part.status === 'error' ? 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30' :
    'border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/50';
  const statusIcon = part.status === 'calling' ? '⏳' : part.status === 'success' ? '✓' : '✗';
  const statusTextColor =
    part.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' :
    part.status === 'error' ? 'text-red-500 dark:text-red-400' :
    'text-amber-500';

  return (
    <div className="py-0.5 pl-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:shadow-sm ${statusColor} ${isActive ? 'animate-pulse' : ''}`}
      >
        <span>{icon}</span>
        <span className="font-medium text-slate-700 dark:text-slate-300">{part.toolName}</span>
        {part.inputSummary && (
          <span className="text-slate-400 dark:text-slate-500 max-w-[200px] truncate">{part.inputSummary}</span>
        )}
        <span className={`text-[10px] ${statusTextColor}`}>{statusIcon}</span>
        {expanded ? <ChevronDown className="h-2.5 w-2.5 text-slate-400" /> : <ChevronRight className="h-2.5 w-2.5 text-slate-400" />}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-1.5 mb-1">
          {part.input != null && (
            <pre className="text-[10px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 overflow-x-auto max-h-40 whitespace-pre-wrap border border-slate-100 dark:border-slate-700/50">
              {typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          {part.output != null && (
            <pre className="text-[10px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 overflow-x-auto max-h-40 whitespace-pre-wrap border border-slate-100 dark:border-slate-700/50">
              {typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2)}
            </pre>
          )}
          {part.error && (
            <div className="text-[11px] text-red-600 dark:text-red-400 px-2">{part.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool group (multiple consecutive tool calls) ───────────────────────────

function ToolGroup({ tools }: { tools: ToolCallMessagePart[] }) {
  const [expanded, setExpanded] = useState(false);
  const allDone = tools.every((t) => t.status !== 'calling');
  const hasError = tools.some((t) => t.status === 'error');
  const statusColor = hasError
    ? 'border-red-200 bg-red-50/30 dark:border-red-800 dark:bg-red-950/20'
    : allDone
      ? 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20'
      : 'border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/50';

  return (
    <div className="py-1 pl-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:shadow-sm ${statusColor} ${!allDone ? 'animate-pulse' : ''}`}
      >
        <span>🔧</span>
        <span className="font-medium text-slate-700 dark:text-slate-300">
          {tools.length} tool calls
        </span>
        {allDone && !hasError && <span className="text-emerald-500 text-[10px]">✓ all done</span>}
        {hasError && <span className="text-red-500 text-[10px]">✗ {tools.filter(t => t.status === 'error').length} failed</span>}
        {!allDone && <span className="text-amber-500 text-[10px]">⏳ running</span>}
        {expanded ? <ChevronDown className="h-2.5 w-2.5 text-slate-400" /> : <ChevronRight className="h-2.5 w-2.5 text-slate-400" />}
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {tools.map((t) => (
            <ToolCallChip key={t.id} part={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Context badge ──────────────────────────────────────────────────────────

function ContextBadge({ model, chars, images }: { model: string; chars: number; images: number }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 pl-2 text-[10px] text-slate-400 dark:text-slate-500">
      <span>📊</span>
      <span>{model}</span>
      <span>·</span>
      <span>{chars.toLocaleString()} chars</span>
      {images > 0 && <><span>·</span><span>{images} img</span></>}
    </div>
  );
}

// ─── Approval card ──────────────────────────────────────────────────────────

function ApprovalCard({ summary, status, onApprove, onReject }: {
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const isPending = status === 'pending';
  const borderColor = isPending
    ? 'border-amber-300 dark:border-amber-600'
    : status === 'approved'
      ? 'border-emerald-300 dark:border-emerald-700'
      : 'border-red-300 dark:border-red-700';
  const bgColor = isPending
    ? 'bg-amber-50/60 dark:bg-amber-950/20'
    : status === 'approved'
      ? 'bg-emerald-50/40 dark:bg-emerald-950/15'
      : 'bg-red-50/40 dark:bg-red-950/15';

  return (
    <div className={`rounded-xl border-2 ${borderColor} ${bgColor} px-4 py-3 my-2 ${isPending ? 'animate-pulse' : ''}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <AlertTriangle className={`h-4 w-4 ${isPending ? 'text-amber-500' : status === 'approved' ? 'text-emerald-500' : 'text-red-500'}`} />
        <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
          {isPending ? 'Plan needs approval' : status === 'approved' ? 'Plan approved' : 'Plan rejected'}
        </span>
      </div>
      {summary && (
        <p className="text-[12px] text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-wrap mb-2">
          {summary}
        </p>
      )}
      {isPending && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onApprove}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700 transition-colors shadow-sm"
          >
            Approve
          </button>
          <button
            onClick={onReject}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-red-700 transition-colors shadow-sm"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Observer finding ───────────────────────────────────────────────────────

const SEV_STYLE: Record<string, string> = {
  critical: 'border-red-300 bg-red-50/40 text-red-700 dark:border-red-700 dark:bg-red-950/20 dark:text-red-300',
  high: 'border-orange-300 bg-orange-50/40 text-orange-700 dark:border-orange-700 dark:bg-orange-950/20 dark:text-orange-300',
  medium: 'border-amber-300 bg-amber-50/40 text-amber-700 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-300',
  low: 'border-slate-200 bg-slate-50/40 text-slate-600 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-400',
};

function ObserverFinding({ severity, title, detail }: { severity: string; title: string; detail?: string }) {
  const style = SEV_STYLE[severity] ?? SEV_STYLE.low;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 my-1 text-[12px] ${style}`}>
      <Eye className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div>
        <span className="font-medium">[{severity}]</span>{' '}
        <span>{title}</span>
        {detail && <p className="mt-0.5 text-[11px] opacity-70">{detail}</p>}
      </div>
    </div>
  );
}

// ─── Error block ────────────────────────────────────────────────────────────

function ErrorBlock({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30 px-3 py-2 my-1 text-[12px] text-red-700 dark:text-red-300">
      <span className="text-red-500 mt-0.5">✗</span>
      <div>
        <span className="font-medium">{message}</span>
        {detail && <p className="mt-0.5 text-[11px] opacity-70">{detail}</p>}
      </div>
    </div>
  );
}

// ─── Investigation prompt builder ───────────────────────────────────────────

function buildInvestigationPrompt(
  messages: ChatMessage[],
  meta: { sessionId?: string; prompt?: string; status?: string; model?: string; provider?: string },
): string {
  const lines: string[] = [];

  lines.push('You are investigating an Orchestrace agent session. Analyze the trace below and help identify issues, failures, or unexpected behavior.\n');
  lines.push('## Session metadata');
  if (meta.sessionId) lines.push(`- Session ID: ${meta.sessionId}`);
  if (meta.provider && meta.model) lines.push(`- Model: ${meta.provider}/${meta.model}`);
  if (meta.status) lines.push(`- Status: ${meta.status}`);
  lines.push('');

  if (meta.prompt) {
    lines.push('## Original prompt');
    lines.push(meta.prompt);
    lines.push('');
  }

  lines.push('## Session trace\n');

  for (const msg of messages) {
    const roleTag = msg.role.toUpperCase();
    const phaseSuffix = msg.phase ? ` [${msg.phase}]` : '';
    const modelSuffix = msg.metadata?.model ? ` (${msg.metadata.model})` : '';
    lines.push(`### ${roleTag}${phaseSuffix}${modelSuffix}`);

    for (const part of msg.parts) {
      switch (part.type) {
        case 'text':
          lines.push(part.text);
          break;
        case 'reasoning':
          lines.push(`<reasoning>\n${part.text}\n</reasoning>`);
          break;
        case 'tool-call': {
          const tc = part as ToolCallMessagePart;
          const statusStr = tc.status === 'success' ? '✓' : tc.status === 'error' ? '✗ FAILED' : '⏳';
          lines.push(`**Tool: ${tc.toolName}** ${statusStr}`);
          if (tc.inputSummary) lines.push(`  Input: ${tc.inputSummary}`);
          if (tc.error) lines.push(`  Error: ${tc.error}`);
          if (tc.outputSummary) lines.push(`  Output: ${tc.outputSummary}`);
          break;
        }
        case 'phase-transition':
          lines.push(`--- Phase: ${part.label} ---`);
          break;
        case 'context-snapshot':
          lines.push(`[Context: ${part.model} · ${part.textChars.toLocaleString()} chars]`);
          break;
        case 'approval-request':
          lines.push(`[Plan approval: ${part.status}] ${part.planSummary}`);
          break;
        case 'observer-finding':
          lines.push(`[Observer ${part.severity}] ${part.title}${part.detail ? ': ' + part.detail : ''}`);
          break;
        case 'error':
          lines.push(`**ERROR:** ${part.message}${part.detail ? '\n' + part.detail : ''}`);
          break;
      }
    }
    lines.push('');
  }

  lines.push('## Investigation questions');
  lines.push('1. Were there any tool call failures? What caused them?');
  lines.push('2. Did the agent follow a logical plan or did it get stuck in loops?');
  lines.push('3. Were the right models used for the right phases (planning vs implementation)?');
  lines.push('4. Are there any errors or observer findings that need attention?');
  lines.push('5. What is the overall health assessment of this session?');

  return lines.join('\n');
}
