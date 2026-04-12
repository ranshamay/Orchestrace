import { describe, expect, it } from 'vitest';
import { parseLogFindingsForTest } from '../src/observer/log-watcher.js';

describe('log watcher parser validation gates', () => {
  it('returns empty findings for malformed roots and finding containers', () => {
    expect(parseLogFindingsForTest('null')).toEqual([]);
    expect(parseLogFindingsForTest('{"findings":{}}')).toEqual([]);
    expect(parseLogFindingsForTest('{"findings":"bad"}')).toEqual([]);
  });

  it('parses fenced JSON and filters invalid finding entries', () => {
    const findings = parseLogFindingsForTest(
      '```json\n' +
        JSON.stringify({
          findings: [
            {
              category: 'performance',
              severity: 'high',
              title: 'Redundant polling loop',
              description: 'The same endpoint is polled excessively.',
              evidence: [{ text: 'Backoff requests and cache intermediate state.' }],
              relevantFiles: ['packages/cli/src/observer/log-watcher.ts'],
              logSnippet: 'poll request repeated 1000x',
            },
            123,
            { title: 'missing description' },
          ],
        }) +
        '\n```',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('performance');
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.evidence?.[0]?.text).toContain('Backoff requests');
  });

  it('keeps compatibility fallback from issueSummary to suggestedFix', () => {
    const findings = parseLogFindingsForTest(
      JSON.stringify({
        findings: [
          {
            title: 'Legacy summary format',
            description: 'Model returned issueSummary instead of suggestedFix.',
            issueSummary: 'Use issueSummary as compatibility fallback.',
          },
        ],
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedFix).toBe('Use issueSummary as compatibility fallback.');
  });
});