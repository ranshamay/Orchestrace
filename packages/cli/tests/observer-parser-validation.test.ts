import { describe, expect, it } from 'vitest';
import { ALL_FINDING_CATEGORIES } from '../src/observer/types.js';
import { parseAnalysisResponseForTest } from '../src/observer/analyzer.js';
import { parseRealtimeFindingsForTest } from '../src/observer/session-observer.js';

describe('observer parser validation gates', () => {
  it('rejects malformed analyzer payload roots and findings containers', () => {
    expect(parseAnalysisResponseForTest('null', ALL_FINDING_CATEGORIES)).toEqual({ findings: [] });
    expect(parseAnalysisResponseForTest('[]', ALL_FINDING_CATEGORIES)).toEqual({ findings: [] });
    expect(parseAnalysisResponseForTest('{"findings":{}}', ALL_FINDING_CATEGORIES)).toEqual({ findings: [] });
  });

  it('normalizes analyzer legacy suggestedFix into evidence and filters invalid entries', () => {
    const result = parseAnalysisResponseForTest(
      JSON.stringify({
        findings: [
          {
            category: 'agent-efficiency',
            severity: 'high',
            title: 'Repeated discovery loop',
            description: 'Implementation repeats planning audit without edits.',
            suggestedFix: 'Stop discovery and apply direct edit_file/write_file changes.',
          },
          42,
          null,
          { title: 'Missing body' },
        ],
      }),
      ALL_FINDING_CATEGORIES,
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('agent-efficiency');
    expect(result.findings[0]?.evidence[0]?.text).toContain('Stop discovery');
  });

  it('rejects malformed realtime payload roots and findings containers without throwing', () => {
    expect(parseRealtimeFindingsForTest('null', ALL_FINDING_CATEGORIES, 'implementation')).toEqual([]);
    expect(parseRealtimeFindingsForTest('[]', ALL_FINDING_CATEGORIES, 'implementation')).toEqual([]);
    expect(
      parseRealtimeFindingsForTest('{"findings":"bad"}', ALL_FINDING_CATEGORIES, 'implementation'),
    ).toEqual([]);
  });

  it('normalizes realtime evidence from legacy suggestedFix and filters invalid candidates', () => {
    const findings = parseRealtimeFindingsForTest(
      JSON.stringify({
        findings: [
          {
            category: 'code-quality',
            severity: 'medium',
            title: 'Unsafe coercion path',
            description: 'Parser coerces unknown object values too early.',
            suggestedFix: 'Validate candidate object shape before coercion.',
          },
          false,
          { description: 'missing title', suggestedFix: 'x' },
        ],
      }),
      ALL_FINDING_CATEGORIES,
      'implementation',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('code-quality');
    expect(findings[0]?.evidence[0]?.text).toContain('Validate candidate object shape');
    expect(findings[0]?.phase).toBe('implementation');
  });
});