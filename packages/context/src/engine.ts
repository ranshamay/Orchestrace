import type {
  ContextBuildRequest,
  ContextBuildResult,
  ContextEngineOptions,
  ContextEnvelope,
  CompactionLlmDelegate,
  ModelInfo,
  BudgetPolicy,
} from './types.js';
import { ContextBudgetManager } from './budget.js';
import { compactHybrid } from './compaction/engine.js';
import { countTokens } from './tokenizer.js';

const RECENCY_ANCHOR_COUNT = 4;

export class ContextEngine {
  private readonly budget: ContextBudgetManager;
  private readonly compactionDelegate?: CompactionLlmDelegate;

  constructor(options: ContextEngineOptions = {}) {
    this.budget = new ContextBudgetManager(options.modelInfo, options.budgetPolicy);
    this.compactionDelegate = options.compactionDelegate;
  }

  get budgetManager(): ContextBudgetManager {
    return this.budget;
  }

  async buildContext(request: ContextBuildRequest): Promise<ContextBuildResult> {
    const {
      systemPrompt,
      turns,
      executionState,
      sharedFacts,
      turnsSinceLastCompaction,
      previousCompressedHistory,
    } = request;

    // Build sections with token counts
    const systemSection = this.budget.buildSection('system_prompt', systemPrompt, 'anchor', false);

    const sharedIndex = sharedFacts.length > 0
      ? this.buildFactsIndex(sharedFacts)
      : '';
    const sharedSection = this.budget.buildSection('shared_context_index', sharedIndex, 'high', false);

    const execSection = this.budget.buildSection('execution_state', executionState, 'high', false);

    // Build recent turns (tail anchors – never compacted)
    const recentCount = Math.min(RECENCY_ANCHOR_COUNT, turns.length);
    const recentTurns = turns.slice(-recentCount);
    const recentContent = recentTurns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
    const recentSection = this.budget.buildSection('recent_turns', recentContent, 'anchor', false);

    // Calculate history budget
    const historyBudget = this.budget.allocateHistoryBudget(
      systemSection.tokens,
      recentSection.tokens,
      execSection.tokens,
      sharedSection.tokens,
    );

    // Build older turns (everything except tail anchors)
    const olderTurns = turns.slice(0, turns.length - recentCount);
    const olderTokens = olderTurns.reduce((sum, t) => sum + t.tokens, 0);

    // Check if compaction is needed
    const totalBeforeCompaction = systemSection.tokens + recentSection.tokens + execSection.tokens + sharedSection.tokens + olderTokens;
    const compactionLevel = this.budget.needsCompaction(totalBeforeCompaction, turnsSinceLastCompaction);

    let compressedHistory = previousCompressedHistory ?? '';
    let compactionPerformed = false;
    let compactionResult;

    if (compactionLevel !== 'none' && olderTurns.length > 0) {
      const result = await compactHybrid(
        {
          turns: olderTurns,
          anchorCount: Math.min(2, olderTurns.length),
          budgetTokens: historyBudget,
        },
        this.compactionDelegate,
      );

      compressedHistory = result.compressedHistory;
      compactionPerformed = true;
      compactionResult = result;
    } else if (olderTurns.length > 0 && !previousCompressedHistory) {
      // No compaction needed, include older turns as-is
      compressedHistory = olderTurns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
    }

    const historySection = this.budget.buildSection(
      'compressed_history',
      compressedHistory,
      compactionPerformed ? 'medium' : 'high',
      true,
    );

    const totalTokens = systemSection.tokens + recentSection.tokens + execSection.tokens + sharedSection.tokens + historySection.tokens;

    const envelope: ContextEnvelope = {
      systemPrompt: systemSection,
      recentTurns: recentSection,
      executionState: execSection,
      sharedContextIndex: sharedSection,
      compressedHistory: historySection,
      totalTokens,
      budgetTokens: this.budget.maxInputTokens,
      compacted: compactionPerformed,
    };

    // Assemble user prompt
    const userPromptParts: string[] = [];

    if (compressedHistory) {
      userPromptParts.push(compactionPerformed
        ? `[Compressed conversation history]\n${compressedHistory}`
        : `Conversation so far:\n${compressedHistory}`);
    }

    if (executionState) {
      userPromptParts.push(`[Current execution state]\n${executionState}`);
    }

    if (sharedIndex) {
      userPromptParts.push(`[Shared context – use context_share_read to read full entries]\n${sharedIndex}`);
    }

    if (recentContent) {
      userPromptParts.push(`[Recent conversation]\n${recentContent}`);
    }

    userPromptParts.push('Reply as ASSISTANT and continue from the latest user message.');

    return {
      systemPrompt,
      userPrompt: userPromptParts.join('\n\n'),
      envelope,
      compactionPerformed,
      compactionResult,
    };
  }

  private buildFactsIndex(facts: { id: string; content: string; tags: string[]; author: string }[]): string {
    const lines = facts.map(
      (f) => `- [${f.id}] (${f.tags.join(', ')}) by ${f.author}: ${f.content.length > 120 ? f.content.slice(0, 120) + '...' : f.content}`,
    );
    return `Shared context (${facts.length} facts available – use context_share_read with fact ID for full content):\n${lines.join('\n')}`;
  }
}
