import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAnalysisResponse } from '../src/observer/analyzer.js';
import { parseRealtimeFindings } from '../src/observer/session-observer.js';
import type { FindingCategory } from '../src/observer/types.js';

const ALL_CATEGORIES: FindingCategory[] = [
  'code-quality',
  'performance',
  'agent-efficiency',
  'architecture',
  'test-coverage',
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observer LLM parsing hardening', () => {
  it('gracefully falls back for malformed JSON and logs structured diagnostics', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseAnalysisResponse('```json\n{"findings": [\n```', ALL_CATEGORIES);

    expect(result).toEqual({ findings: [] });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain('Failed to parse LLM analysis response');
    expect(meta).toEqual(
      expect.objectContaining({
        reason: 'json_parse_failed',
        parseAttempts: expect.any(Number),
        preview: expect.any(String),
      }),
    );
  });

  it('extracts findings from fenced JSON wrapped in prose', () => {
    const input = [
      'Here is the analysis:',
      '```json',
      JSON.stringify(
        {
          findings: [
            {
              category: 'performance',
              severity: 'high',
              title: 'Slow path in loop',
              description: 'A repeated expensive call appears in a tight loop.',
              suggestedFix: 'Memoize the lookup result outside the loop.',
              relevantFiles: ['src/loop.ts'],
            },
          ],
        },
        null,
        2,
      ),
      '```',
      'Thanks!',
    ].join('\n');

    const result = parseAnalysisResponse(input, ALL_CATEGORIES);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        category: 'performance',
        severity: 'high',
        title: 'Slow path in loop',
      }),
    );
  });

  it('returns empty findings for missing findings array and logs schema reason', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parseAnalysisResponse('{"note":"not the expected schema"}', ALL_CATEGORIES);

    expect(result).toEqual({ findings: [] });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, meta] = errorSpy.mock.calls[0] ?? [];
    expect(meta).toEqual(
      expect.objectContaining({
        reason: 'missing_findings_array',
      }),
    );
  });

  it('filters invalid entries and disallowed categories in realtime parser', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const payload = {
      findings: [
        {
          category: 'performance',
          severity: 'critical',
          title: 'N+1 query on render',
          description: 'The same query executes for each row.',
          suggestedFix: 'Batch query fetches.',
        },
        {
          category: 'architecture',
          severity: 'low',
          title: 'Should be excluded by category allowlist',
          description: 'Valid shape but filtered by allowed categories.',
          suggestedFix: 'No-op',
        },
        {
          category: 'code-quality',
          severity: 'oops',
          title: 'Defaults invalid severity',
          description: 'Invalid severity should normalize to medium.',
          suggestedFix: 'Fix typing.',
        },
        {
          category: 'code-quality',
          severity: 'medium',
          title: 'Missing fields entry should drop',
        },
      ],
    };

    const findings = parseRealtimeFindings(
      JSON.stringify(payload),
      ['performance', 'code-quality'],
      'implementation',
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.title)).toEqual([
      'N+1 query on render',
      'Defaults invalid severity',
    ]);
    expect(findings[1]?.severity).toBe('medium');
    expect(findings.every((f) => f.phase === 'implementation')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0] ?? [];
    expect(meta).toEqual(
      expect.objectContaining({
        invalidEntries: 1,
        filteredByCategory: 1,
        normalizedSeverity: 1,
      }),
    );
  });
});