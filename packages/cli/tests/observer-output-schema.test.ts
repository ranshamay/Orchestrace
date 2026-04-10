import { describe, expect, it } from 'vitest';
import {
  buildObserverFindingsJsonSchemaBlock,
  parseObserverFindingsResponse,
  stripJsonMarkdownFences,
} from '@orchestrace/shared';

describe('observer output schema helpers', () => {
  it('parses fenced JSON and normalizes severities/logSnippet for log channels', () => {
    const text = [
      '```json',
      JSON.stringify({
        findings: [
          {
            category: 'unknown-category',
            severity: 'urgent',
            title: 'Timeout loop',
            description: 'Repeated timeout in backend call path.',
            suggestedFix: 'Add bounded retry with jitter and circuit-breaker fallback.',
            relevantFiles: ['packages/cli/src/ui-server.ts', 42],
          },
        ],
      }),
      '```',
    ].join('\n');

    const parsed = parseObserverFindingsResponse(text, {
      categories: ['error-pattern', 'performance', 'configuration', 'reliability', 'security'] as const,
      categoryValidation: { type: 'coerce', fallback: 'error-pattern' },
      includeLogSnippet: true,
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toEqual({
      category: 'error-pattern',
      severity: 'medium',
      title: 'Timeout loop',
      description: 'Repeated timeout in backend call path.',
      suggestedFix: 'Add bounded retry with jitter and circuit-breaker fallback.',
      relevantFiles: ['packages/cli/src/ui-server.ts'],
      logSnippet: '',
    });
  });

  it('filters unknown categories for session observer mode', () => {
    const text = JSON.stringify({
      findings: [
        {
          category: 'architecture',
          severity: 'high',
          title: 'Prompt drift risk',
          description: 'Session and log channels use separate schema strings.',
          suggestedFix: 'Use shared schema builder/parsers.',
        },
        {
          category: 'not-allowed',
          severity: 'high',
          title: 'Should be dropped',
          description: 'Unknown category.',
          suggestedFix: 'Drop this finding.',
        },
      ],
    });

    const parsed = parseObserverFindingsResponse(text, {
      categories: ['code-quality', 'performance', 'agent-efficiency', 'architecture', 'test-coverage'] as const,
      categoryValidation: { type: 'filter' },
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.category).toBe('architecture');
  });

  it('renders canonical schema text with requested fields', () => {
    const rendered = buildObserverFindingsJsonSchemaBlock({
      categories: ['code-quality', 'performance'] as const,
      includeLogSnippet: true,
    });

    expect(rendered).toContain('"category": "code-quality|performance"');
    expect(rendered).toContain('"severity": "low|medium|high|critical"');
    expect(rendered).toContain('"suggestedFix"');
    expect(rendered).toContain('"logSnippet"');
  });

  it('strips markdown fences safely', () => {
    expect(stripJsonMarkdownFences('```json\n{"findings":[]}\n```')).toBe('{"findings":[]}');
    expect(stripJsonMarkdownFences('{"findings":[]}')).toBe('{"findings":[]}');
  });
});