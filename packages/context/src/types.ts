import type { LlmPromptInput } from '@orchestrace/provider';

// ---------------------------------------------------------------------------
// Tagged facts – shared context store
// ---------------------------------------------------------------------------

export interface SharedFact {
  id: string;
  content: string;
  tags: string[];
  author: string;
  createdAt: number;
}

export interface SharedContextStore {
  add(fact: Omit<SharedFact, 'id' | 'createdAt'>, graphId?: string): SharedFact;
  query(tags: string[], graphId?: string): SharedFact[];
  readById(id: string): SharedFact | undefined;
  list(graphId?: string): SharedFact[];
  remove(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Context envelope – structured context for a single LLM call
// ---------------------------------------------------------------------------

export interface ContextSection {
  name: string;
  content: string;
  tokens: number;
  priority: 'anchor' | 'high' | 'medium' | 'low';
  compactable: boolean;
}

export interface ContextEnvelope {
  systemPrompt: ContextSection;
  recentTurns: ContextSection;
  executionState: ContextSection;
  sharedContextIndex: ContextSection;
  compressedHistory: ContextSection;
  totalTokens: number;
  budgetTokens: number;
  compacted: boolean;
}

// ---------------------------------------------------------------------------
// Budget policy
// ---------------------------------------------------------------------------

export interface BudgetPolicy {
  contextWindow: number;
  maxOutputTokens: number;
  softThresholdRatio: number;
  hardThresholdRatio: number;
  periodicCheckTurns: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  softThresholdRatio: 0.70,
  hardThresholdRatio: 0.85,
  periodicCheckTurns: 12,
};

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export interface CompactionInput {
  turns: ConversationTurn[];
  anchorCount: number;
  budgetTokens: number;
}

export interface CompactionResult {
  compressedHistory: string;
  droppedTurnCount: number;
  retainedAnchorCount: number;
  compactionMethod: 'heuristic' | 'llm' | 'hybrid';
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  turnIndex: number;
  tokens: number;
  isAnchor?: boolean;
}

// ---------------------------------------------------------------------------
// LLM compaction delegate
// ---------------------------------------------------------------------------

export interface CompactionLlmDelegate {
  summarize(text: string, maxTokens: number, signal?: AbortSignal): Promise<string>;
}

// ---------------------------------------------------------------------------
// Model info
// ---------------------------------------------------------------------------

export interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Context engine
// ---------------------------------------------------------------------------

export interface ContextEngineOptions {
  budgetPolicy?: Partial<BudgetPolicy>;
  modelInfo?: ModelInfo;
  compactionDelegate?: CompactionLlmDelegate;
}

export interface ContextBuildRequest {
  systemPrompt: string;
  turns: ConversationTurn[];
  executionState: string;
  sharedFacts: SharedFact[];
  turnsSinceLastCompaction: number;
  previousCompressedHistory?: string;
}

export interface ContextBuildResult {
  systemPrompt: string;
  userPrompt: LlmPromptInput;
  envelope: ContextEnvelope;
  compactionPerformed: boolean;
  compactionResult?: CompactionResult;
}
