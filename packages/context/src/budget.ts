import type { BudgetPolicy, ContextSection, ModelInfo } from './types.js';
import { DEFAULT_BUDGET_POLICY } from './types.js';
import { countTokens } from './tokenizer.js';

export class ContextBudgetManager {
  private readonly policy: BudgetPolicy;

  constructor(modelInfo?: ModelInfo, policyOverrides?: Partial<BudgetPolicy>) {
    this.policy = {
      ...DEFAULT_BUDGET_POLICY,
      ...policyOverrides,
    };
    if (modelInfo) {
      this.policy.contextWindow = modelInfo.contextWindow;
      this.policy.maxOutputTokens = modelInfo.maxOutputTokens;
    }
  }

  get contextWindow(): number {
    return this.policy.contextWindow;
  }

  get maxInputTokens(): number {
    return this.policy.contextWindow - this.policy.maxOutputTokens;
  }

  get softThreshold(): number {
    return Math.floor(this.maxInputTokens * this.policy.softThresholdRatio);
  }

  get hardThreshold(): number {
    return Math.floor(this.maxInputTokens * this.policy.hardThresholdRatio);
  }

  get periodicCheckTurns(): number {
    return this.policy.periodicCheckTurns;
  }

  estimateTokens(text: string): number {
    return countTokens(text);
  }

  buildSection(name: string, content: string, priority: ContextSection['priority'], compactable: boolean): ContextSection {
    return {
      name,
      content,
      tokens: countTokens(content),
      priority,
      compactable,
    };
  }

  needsCompaction(totalTokens: number, turnsSinceLastCompaction: number): 'none' | 'soft' | 'hard' {
    if (totalTokens >= this.hardThreshold) return 'hard';
    if (totalTokens >= this.softThreshold) return 'soft';
    if (turnsSinceLastCompaction >= this.policy.periodicCheckTurns && totalTokens > this.softThreshold * 0.8) return 'soft';
    return 'none';
  }

  allocateHistoryBudget(systemPromptTokens: number, recentTurnsTokens: number, executionStateTokens: number, sharedIndexTokens: number): number {
    const reserved = systemPromptTokens + recentTurnsTokens + executionStateTokens + sharedIndexTokens;
    const available = this.softThreshold - reserved;
    return Math.max(0, available);
  }
}
