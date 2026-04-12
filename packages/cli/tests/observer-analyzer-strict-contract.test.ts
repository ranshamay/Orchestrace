import { describe, expect, it, vi } from 'vitest';
import { analyzeSessionSummaries } from '../src/observer/analyzer.js';
import { DEFAULT_OBSERVER_CONFIG, type ObserverConfig } from '../src/observer/types.js';
import type { SessionSummary } from '../src/observer/summarizer.js';

type AnalyzeArgs = Parameters<typeof analyzeSessionSummaries>;
type LlmAdapterLike = AnalyzeArgs[0];

function createSummary(): SessionSummary {
  return {
    sessionId: 's-1',
    config: {
      prompt: 'Fix parser',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      workspacePath: '/tmp/workspace',
      autoApprove: true,
    },
    status: 'completed',
    llmStatusHistory: [],
    dagEvents: [],
    toolCalls: [],
    agentGraph: [],
    todos: [],
    streamedText: '',
    totalEvents: 3,
    durationMs: 1000,
  };
}

describe('observer analyzer strict finding contract', () => {
  it('accepts only schemaVersion=2 findings with 2-3 strict evidence entries', async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          findings: [
            {
              schemaVersion: '2',
              category: 'architecture',
              severity: 'high',
              title: 'Parser contract drift',
              description: 'Parsers are inconsistent across ingestion paths.',
              evidence: [
                { text: 'Extract strict evidence validation into shared observer utilities.' },
                { text: 'Replace legacy parser fallbacks with strict v2 evidence checks.' },
              ],
              relevantFiles: ['packages/cli/src/observer/analyzer.ts'],
            },
          ],
        }),
      })),
    } as LlmAdapterLike;

    const config: ObserverConfig = {
      ...DEFAULT_OBSERVER_CONFIG,
      enabled: true,
      assessmentCategories: ['architecture'],
    };

    const result = await analyzeSessionSummaries(llm, config, [createSummary()]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.schemaVersion).toBe('2');
    expect(result.findings[0]?.evidence).toHaveLength(2);
  });

  it('drops legacy-only and non-conforming findings deterministically', async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          findings: [
            {
              schemaVersion: '2',
              category: 'architecture',
              severity: 'high',
              title: 'Legacy fallback still present',
              description: 'Legacy path still in parser.',
              suggestedFix: 'Remove legacy fallback.',
              evidence: [
                { text: 'Remove legacy fallback code paths in observer parser modules.' },
                { text: 'Update tests to enforce schemaVersion 2 evidence contract.' },
              ],
            },
            {
              schemaVersion: '2',
              category: 'architecture',
              severity: 'medium',
              title: 'Hedging language present',
              description: 'Evidence uses recommendation language.',
              evidence: [
                { text: 'You should tighten parser checks immediately.' },
                { text: 'Consider removing suggestedFix compatibility handling.' },
              ],
            },
            {
              schemaVersion: '2',
              category: 'architecture',
              severity: 'medium',
              title: 'Too few evidence entries',
              description: 'Only one evidence entry provided.',
              evidence: [{ text: 'Enforce evidence count bounds in parser validation.' }],
            },
          ],
        }),
      })),
    } as LlmAdapterLike;

    const config: ObserverConfig = {
      ...DEFAULT_OBSERVER_CONFIG,
      enabled: true,
      assessmentCategories: ['architecture'],
    };

    const result = await analyzeSessionSummaries(llm, config, [createSummary()]);
    expect(result.findings).toEqual([]);
  });
});