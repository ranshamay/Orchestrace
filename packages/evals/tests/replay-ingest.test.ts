import { describe, expect, it } from 'vitest';
import { defaultEvalCases } from '../src/index.js';
import { selectEvalCases, toEvalRunRecord } from '../src/run-evals.js';

describe('eval replay ingestion helpers', () => {
  it('selects docs-update only for docs-only changed files', () => {
    const selected = selectEvalCases(defaultEvalCases, [], ['docs/PLAN.md', 'README.md']);
    expect(selected.map((evalCase) => evalCase.id)).toEqual(['docs-update']);
  });

  it('converts replay artifact to run record and extracts changed files', () => {
    const record = toEvalRunRecord(
      {
        runId: 'run-1',
        graphId: 'graph-1',
        taskId: 'task',
        status: 'completed',
        retries: 1,
        usage: { input: 120, output: 45, cost: 0 },
        replay: {
          attempts: [
            {
              phase: 'implementation',
              validation: { passed: true },
              toolCalls: [
                {
                  toolName: 'write_file',
                  status: 'started',
                  input: '{"path":"packages/core/src/index.ts"}',
                },
              ],
            },
          ],
        },
      },
      {
        selectedCaseIds: new Set(['safe-refactor']),
        caseMap: {
          taskIds: { task: 'safe-refactor' },
          graphIds: {},
          runIds: {},
          defaultCaseId: undefined,
        },
        defaultCaseId: undefined,
      },
    );

    expect(record).toBeDefined();
    expect(record?.caseId).toBe('safe-refactor');
    expect(record?.status).toBe('completed');
    expect(record?.retries).toBe(1);
    expect(record?.validationPassed).toBe(true);
    expect(record?.filesChanged).toContain('packages/core/src/index.ts');
  });
});