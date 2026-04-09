// ---------------------------------------------------------------------------
// Observer — Per-Session Real-Time Observer
// ---------------------------------------------------------------------------
// Attaches to a running session's event stream, accumulates context (CoT,
// tool calls, agent graph, errors), and triggers LLM analysis at key phase
// boundaries.  Findings are emitted as session events so the UI can display
// them inline alongside the session's own output.
// ---------------------------------------------------------------------------

import type { EventStore, SessionEvent } from '@orchestrace/store';
import type { LlmAdapter } from '@orchestrace/provider';
import type { ObserverConfig, FindingCategory, FindingSeverity } from './types.js';
import { ALL_FINDING_CATEGORIES } from './types.js';
import { REALTIME_OBSERVER_SYSTEM_PROMPT } from './prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObserverSessionStatus = 'idle' | 'watching' | 'analyzing' | 'done';

export interface RealtimeFinding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  issueSummary: string;
  evidence: string[];
  severityRationale?: string;
  relevantFiles?: string[];
  phase: string;
  detectedAt: string;
}

export interface SessionObserverState {
  status: ObserverSessionStatus;
  findings: RealtimeFinding[];
  analyzedSteps: number;
  lastAnalyzedAt: string | null;
}

/** Callback to emit observer events into the session's event/SSE stream. */
export type ObserverEventEmitter = (event: {
  type: 'session:observer-status-change' | 'session:observer-finding';
  payload: Record<string, unknown>;
}) => void;

// ---------------------------------------------------------------------------
// Accumulated context from event stream
// ---------------------------------------------------------------------------

interface AccumulatedContext {
  prompt: string;
  provider: string;
  model: string;
  /** Chain-of-thought / streamed text per phase. */
  streamedText: { planning: string; implementation: string };
  /** Tool calls with input/output. */
  toolCalls: Array<{
    time: string;
    toolName: string;
    input: string;
    output: string;
    isError: boolean;
    taskId?: string;
    phase?: string;
  }>;
  /** LLM status transitions. */
  llmStatusHistory: Array<{ time: string; state: string; detail?: string; phase?: string }>;
  /** DAG events (task lifecycle). */
  dagEvents: Array<{ time: string; type: string; taskId?: string; message: string }>;
  /** Agent graph snapshot. */
  agentGraph: Array<{ id: string; name?: string; status?: string; prompt: string }>;
  /** Todos. */
  todos: Array<{ text: string; done: boolean; status?: string }>;
  /** Chat messages. */
  chatMessages: Array<{ role: string; content: string; time: string }>;
  /** Errors encountered. */
  errors: string[];
  /** Total event count. */
  totalEvents: number;
}

// Limits for context accumulation
const STREAM_TEXT_LIMIT = 8_000;
const TOOL_PREVIEW_LIMIT = 3_000;
const DAG_MESSAGE_LIMIT = 600;
const CHAT_MESSAGE_LIMIT = 2_000;

// ---------------------------------------------------------------------------
// SessionObserver
// ---------------------------------------------------------------------------

export class SessionObserver {
  private readonly sessionId: string;
  private readonly eventStore: EventStore;
  private readonly llm: LlmAdapter;
  private readonly config: ObserverConfig;
  private readonly emit: ObserverEventEmitter;
  private readonly resolveApiKey: (provider: string) => Promise<string | undefined>;
  private readonly ctx: AccumulatedContext;
  private state: SessionObserverState;
  private unwatch: (() => void) | null = null;
  private analysisPending = false;
  private abortController = new AbortController();
  private currentPhase: string = 'unknown';
  private analysisCounter = 0;

  constructor(options: {
    sessionId: string;
    eventStore: EventStore;
    llm: LlmAdapter;
    config: ObserverConfig;
    emit: ObserverEventEmitter;
    resolveApiKey: (provider: string) => Promise<string | undefined>;
  }) {
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
    this.llm = options.llm;
    this.config = options.config;
    this.emit = options.emit;
    this.resolveApiKey = options.resolveApiKey;
    this.ctx = {
      prompt: '',
      provider: '',
      model: '',
      streamedText: { planning: '', implementation: '' },
      toolCalls: [],
      llmStatusHistory: [],
      dagEvents: [],
      agentGraph: [],
      todos: [],
      chatMessages: [],
      errors: [],
      totalEvents: 0,
    };
    this.state = {
      status: 'idle',
      findings: [],
      analyzedSteps: 0,
      lastAnalyzedAt: null,
    };
  }

  /** Start watching the session's event stream. */
  start(): void {
    if (this.unwatch) return;
    this.state.status = 'watching';
    this.emitStatusChange();

    this.unwatch = this.eventStore.watch(this.sessionId, 0, (event) => {
      this.onEvent(event);
    });
  }

  /** Stop watching and clean up. */
  stop(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    this.state.status = 'done';
    this.emitStatusChange();
  }

  /** Get current state for API/serialization. */
  getState(): Readonly<SessionObserverState> {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Event Processing
  // -------------------------------------------------------------------------

  private onEvent(event: SessionEvent): void {
    this.ctx.totalEvents++;

    switch (event.type) {
      case 'session:created': {
        const config = event.payload.config;
        this.ctx.prompt = config.prompt ?? '';
        this.ctx.provider = config.provider ?? '';
        this.ctx.model = config.model ?? '';
        break;
      }

      case 'session:llm-status-change': {
        const llmStatus = event.payload.llmStatus as {
          state: string;
          detail?: string;
          phase?: string;
        };
        this.ctx.llmStatusHistory.push({
          time: event.time,
          state: llmStatus.state,
          detail: llmStatus.detail,
          phase: llmStatus.phase,
        });

        const prevPhase = this.currentPhase;
        if (llmStatus.phase) {
          this.currentPhase = llmStatus.phase;
        }

        // Trigger analysis at phase boundaries
        if (this.isAnalysisBoundary(prevPhase, llmStatus.state)) {
          void this.scheduleAnalysis();
        }
        break;
      }

      case 'session:dag-event': {
        const dag = event.payload.event as {
          type: string;
          taskId?: string;
          message: string;
        };

        this.ctx.dagEvents.push({
          time: event.time,
          type: dag.type,
          taskId: dag.taskId,
          message: truncate(dag.message, DAG_MESSAGE_LIMIT),
        });

        // Extract tool calls
        if (dag.type === 'task:tool-call') {
          const parsed = parseToolCall(dag.message);
          if (parsed) {
            this.ctx.toolCalls.push({
              time: event.time,
              toolName: parsed.toolName,
              input: truncate(parsed.input, TOOL_PREVIEW_LIMIT),
              output: truncate(parsed.output, TOOL_PREVIEW_LIMIT),
              isError: parsed.isError,
              taskId: dag.taskId,
              phase: this.currentPhase,
            });
          }
        }

        // Trigger analysis after tool call errors
        if (dag.type === 'task:tool-call' && dag.message.includes('[error]')) {
          void this.scheduleAnalysis();
        }
        break;
      }

      case 'session:stream-delta': {
        const p = event.payload as { taskId: string; phase: string; delta: string };
        const phaseKey = p.phase === 'planning' ? 'planning' : 'implementation';
        if (this.ctx.streamedText[phaseKey].length < STREAM_TEXT_LIMIT) {
          this.ctx.streamedText[phaseKey] += p.delta;
        }
        break;
      }

      case 'session:agent-graph-set': {
        const graph = (event.payload as { graph: Array<{ id: string; name?: string; status?: string; prompt: string }> }).graph;
        this.ctx.agentGraph = graph.map((n) => ({
          id: n.id,
          name: n.name,
          status: n.status,
          prompt: truncate(n.prompt, 500),
        }));
        break;
      }

      case 'session:agent-graph-node-status': {
        const p = event.payload as { nodeId: string; status: string };
        this.ctx.agentGraph = this.ctx.agentGraph.map((n) =>
          n.id === p.nodeId ? { ...n, status: p.status } : n,
        );
        break;
      }

      case 'session:todos-set': {
        const items = (event.payload as { items: Array<{ text: string; done: boolean; status?: string }> }).items;
        this.ctx.todos = items;
        break;
      }

      case 'session:chat-message': {
        const msg = (event.payload as { message: { role: string; content: string } }).message;
        this.ctx.chatMessages.push({
          role: msg.role,
          content: truncate(msg.content, CHAT_MESSAGE_LIMIT),
          time: event.time,
        });
        break;
      }

      case 'session:error-change': {
        const error = event.payload.error as string | undefined;
        if (error) {
          this.ctx.errors.push(error);
        }
        break;
      }

      case 'session:status-change': {
        const status = event.payload.status as string;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          // Final analysis when session ends
          void this.runAnalysis('session-end');
        }
        break;
      }

      default:
        break;
    }
  }

  /** Determine if we should trigger analysis at this state transition. */
  private isAnalysisBoundary(prevPhase: string, newState: string): boolean {
    // Analyze when transitioning from planning to implementation
    if (prevPhase === 'planning' && newState === 'implementing') return true;
    // Analyze when planning completes (awaiting approval)
    if (newState === 'awaiting-approval') return true;
    // Analyze when implementation starts (gives us the plan to review)
    if (newState === 'implementing' && prevPhase !== 'implementation') return true;
    // Analyze on verification failure (retry loop)
    if (newState === 'verification-failed') return true;
    return false;
  }

  private async scheduleAnalysis(): Promise<void> {
    if (this.analysisPending) return;
    this.analysisPending = true;
    // Small delay to batch rapid-fire events
    await new Promise<void>((r) => setTimeout(r, 1_500));
    this.analysisPending = false;
    await this.runAnalysis(this.currentPhase);
  }

  // -------------------------------------------------------------------------
  // LLM Analysis
  // -------------------------------------------------------------------------

  private async runAnalysis(triggerPhase: string): Promise<void> {
    if (this.state.status === 'done') return;
    if (this.ctx.totalEvents < 3) return; // Not enough data

    const previousStatus = this.state.status;
    this.state.status = 'analyzing';
    this.emitStatusChange();

    try {
      const prompt = this.buildAnalysisPrompt(triggerPhase);
      const allowedCategories =
        this.config.assessmentCategories.length > 0
          ? this.config.assessmentCategories
          : ALL_FINDING_CATEGORIES;

      const provider = this.config.provider;
      const apiKey = await this.resolveApiKey(provider);
      const result = await this.llm.complete({
        provider,
        model: this.config.model,
        systemPrompt: REALTIME_OBSERVER_SYSTEM_PROMPT,
        prompt,
        signal: this.abortController.signal,
        apiKey,
        refreshApiKey: () => this.resolveApiKey(provider),
      });

      const findings = parseRealtimeFindings(result.text, allowedCategories, triggerPhase);

      for (const finding of findings) {
        // Deduplicate against existing findings by title
        if (this.state.findings.some((f) => f.title === finding.title)) continue;
        this.state.findings.push(finding);
        this.emit({
          type: 'session:observer-finding',
          payload: { finding },
        });
      }

      this.analysisCounter++;
      this.state.analyzedSteps = this.analysisCounter;
      this.state.lastAnalyzedAt = new Date().toISOString();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error(`[orchestrace][observer] Session ${this.sessionId} analysis error:`, err);
      }
    } finally {
      if ((this.state.status as string) !== 'done') {
        this.state.status = 'watching';
      }
      this.emitStatusChange();
    }
  }

  private buildAnalysisPrompt(triggerPhase: string): string {
    const lines: string[] = [];

    lines.push(`# Real-Time Session Assessment (Phase: ${triggerPhase})`);
    lines.push('');
    lines.push(`Session ID: ${this.sessionId}`);
    lines.push(`Original Task: ${this.ctx.prompt}`);
    lines.push(`Provider: ${this.ctx.provider} / Model: ${this.ctx.model}`);
    lines.push(`Phase Boundary: ${triggerPhase}`);
    lines.push(`Total Events So Far: ${this.ctx.totalEvents}`);
    lines.push('');

    // Agent graph
    if (this.ctx.agentGraph.length > 0) {
      lines.push('## Agent Graph (Task Decomposition)');
      for (const node of this.ctx.agentGraph) {
        lines.push(`- **${node.name ?? node.id}** [${node.status ?? 'unknown'}]: ${node.prompt}`);
      }
      lines.push('');
    }

    // Chain of Thought (streamed text)
    if (this.ctx.streamedText.planning.length > 0) {
      lines.push('## Chain of Thought — Planning');
      lines.push(this.ctx.streamedText.planning);
      lines.push('');
    }
    if (this.ctx.streamedText.implementation.length > 0) {
      lines.push('## Chain of Thought — Implementation');
      lines.push(this.ctx.streamedText.implementation);
      lines.push('');
    }

    // Tool calls
    if (this.ctx.toolCalls.length > 0) {
      lines.push('## Tool Calls');
      for (const tc of this.ctx.toolCalls) {
        const errorTag = tc.isError ? ' [ERROR]' : '';
        lines.push(`### ${tc.toolName}${errorTag} (${tc.phase ?? 'unknown'} phase, task: ${tc.taskId ?? 'n/a'})`);
        if (tc.input) lines.push(`Input: ${tc.input}`);
        if (tc.output) lines.push(`Output: ${tc.output}`);
        lines.push('');
      }
    }

    // Chat messages (user + assistant turns)
    if (this.ctx.chatMessages.length > 0) {
      lines.push('## Chat Context');
      for (const msg of this.ctx.chatMessages) {
        lines.push(`[${msg.role}] ${msg.content}`);
      }
      lines.push('');
    }

    // LLM status history
    if (this.ctx.llmStatusHistory.length > 0) {
      lines.push('## LLM Status Timeline');
      for (const h of this.ctx.llmStatusHistory) {
        lines.push(`- ${h.time}: ${h.state}${h.phase ? ` (${h.phase})` : ''}${h.detail ? ` — ${h.detail}` : ''}`);
      }
      lines.push('');
    }

    // Todos
    if (this.ctx.todos.length > 0) {
      lines.push('## Agent Todos');
      for (const t of this.ctx.todos) {
        lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}${t.status ? ` (${t.status})` : ''}`);
      }
      lines.push('');
    }

    // Errors
    if (this.ctx.errors.length > 0) {
      lines.push('## Errors');
      for (const e of this.ctx.errors) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }

    // Existing findings (so the LLM doesn't repeat them)
    if (this.state.findings.length > 0) {
      lines.push('## Previously Reported Findings (DO NOT repeat these)');
      for (const f of this.state.findings) {
        lines.push(`- [${f.category}/${f.severity}] ${f.title}`);
      }
      lines.push('');
    }

    const allowedCategories =
      this.config.assessmentCategories.length > 0
        ? this.config.assessmentCategories
        : ALL_FINDING_CATEGORIES;

    lines.push(`Allowed categories: ${allowedCategories.join(', ')}`);
    lines.push('');
    lines.push(
      'Respond with a JSON object: { "findings": [{ "category": "...", "severity": "...", "title": "...", "issueSummary": "...", "evidence": ["...", "..."], "severityRationale": "...", "relevantFiles": [...] }] }',
    );
    lines.push('Return ONLY the JSON, no other text. If no issues found, return { "findings": [] }.');

    return lines.join('\n');
  }

  private emitStatusChange(): void {
    this.emit({
      type: 'session:observer-status-change',
      payload: {
        status: this.state.status,
        findings: this.state.findings.length,
        analyzedSteps: this.state.analyzedSteps,
        lastAnalyzedAt: this.state.lastAnalyzedAt,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…[truncated]`;
}

function parseToolCall(
  message: string,
): { toolName: string; input: string; output: string; isError: boolean } | null {
  const toolMatch = message.match(/^Tool\s+(\S+)\s+(input|output)\s+/);
  if (!toolMatch) return null;
  const toolName = toolMatch[1];
  const phase = toolMatch[2];
  const rest = message.slice(toolMatch[0].length);

  if (phase === 'input') {
    return { toolName, input: rest, output: '', isError: false };
  }
  return { toolName, input: '', output: rest, isError: message.includes('[error]') };
}

function parseRealtimeFindings(
  text: string,
  allowedCategories: FindingCategory[],
  triggerPhase: string,
): RealtimeFinding[] {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || !Array.isArray(parsed.findings)) return [];

    const validSeverities: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
    let idCounter = 0;

    return parsed.findings
      .filter(
        (f: Record<string, unknown>) =>
          typeof f.title === 'string' &&
          typeof f.issueSummary === 'string' &&
          Array.isArray(f.evidence),
      )
      .filter((f: Record<string, unknown>) =>
        allowedCategories.includes(f.category as FindingCategory),
      )
      .map((f: Record<string, unknown>): RealtimeFinding => ({
        id: `rt-${Date.now()}-${idCounter++}`,
        category: allowedCategories.includes(f.category as FindingCategory)
          ? (f.category as FindingCategory)
          : 'code-quality',
        severity: validSeverities.includes(f.severity as FindingSeverity)
          ? (f.severity as FindingSeverity)
          : 'medium',
        title: String(f.title),
        issueSummary: String(f.issueSummary),
        evidence: (f.evidence as unknown[])
          .filter((e: unknown) => typeof e === 'string')
          .map((e) => String(e))
          .slice(0, 3),
        severityRationale: typeof f.severityRationale === 'string'
          ? String(f.severityRationale)
          : undefined,
        relevantFiles: Array.isArray(f.relevantFiles)
          ? f.relevantFiles.filter((p: unknown) => typeof p === 'string')
          : undefined,
        phase: triggerPhase,
        detectedAt: new Date().toISOString(),
      }));
  } catch {
    console.error('[orchestrace][observer] Failed to parse real-time analysis response');
    return [];
  }
}
