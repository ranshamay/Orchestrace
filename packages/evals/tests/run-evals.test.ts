import { describe, expect, it } from 'vitest';
import { defaultEvalCases, evaluateSuite, type EvalRunRecord } from '../src/index.js';

describe('evaluateSuite', () => {
  it('passes all baseline cases with compliant records', () => {
    const runRecords: EvalRunRecord[] = [
      {
        caseId: 'fix-failing-test',
        status: 'completed',
        retries: 1,
        filesChanged: ['packages/core/src/orchestrator/orchestrator.ts'],
        validationPassed: true,
        usage: { input: 900, output: 300, cost: 0 },
      },
      {
        caseId: 'safe-refactor',
        status: 'completed',
        retries: 0,
        filesChanged: ['packages/tools/src/index.ts'],
        validationPassed: true,
        usage: { input: 700, output: 250, cost: 0 },
      },
      {
        caseId: 'docs-update',
        status: 'completed',
        retries: 0,
        filesChanged: ['docs/PLAN.md', 'README.md'],
        validationPassed: true,
        usage: { input: 400, output: 120, cost: 0 },
      },
    ];

    const summary = evaluateSuite(defaultEvalCases, runRecords);
    expect(summary.totalCases).toBe(3);
    expect(summary.passedCases).toBe(3);
    expect(summary.failedCases).toBe(0);
    expect(summary.passRate).toBe(1);
  });

  it('fails docs-update when non-doc files are changed', () => {
    const runRecords: EvalRunRecord[] = [
      {
        caseId: 'docs-update',
        status: 'completed',
        retries: 0,
        filesChanged: ['packages/core/src/dag/scheduler.ts'],
        usage: { input: 300, output: 80, cost: 0 },
      },
    ];

    const summary = evaluateSuite(defaultEvalCases, runRecords);
    const docsResult = summary.caseResults.find((result) => result.caseId === 'docs-update');

    expect(docsResult).toBeDefined();
    expect(docsResult?.pass).toBe(false);
    expect(docsResult?.reasons.join(' ')).toContain('Disallowed changed files');
  });
});
