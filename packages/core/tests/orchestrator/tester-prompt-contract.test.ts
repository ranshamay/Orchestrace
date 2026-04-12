import { describe, expect, it } from 'vitest';
import type { TaskNode } from '../../src/dag/types.js';
import { buildTesterPrompt } from '../../src/orchestrator/role-config.js';

function makeTask(): TaskNode {
  return {
    id: 'task',
    name: 'Update UI flow',
    type: 'code',
    prompt: 'Add hotkeys and modal UX improvements',
    dependencies: [],
  };
}

describe('tester prompt contract', () => {
  it('requires explicit ADD-CODEBASE vs VERIFY-ONLY planning split', () => {
    const prompt = buildTesterPrompt({
      node: makeTask(),
      approvedPlan: 'Implement hotkeys and modal behavior',
      implementationResponse: 'Done',
      changedFiles: ['packages/ui/src/App.tsx'],
      validationResults: [],
      attempt: 1,
      uiChangesDetected: true,
      uiTestsRequired: true,
      screenshotEvidenceRequired: true,
      minScreenshotCount: 2,
      uiTestCommandPatterns: ['playwright', 'test:ui'],
    });

    expect(prompt).toContain('ADD-CODEBASE:');
    expect(prompt).toContain('VERIFY-ONLY:');
    expect(prompt).toContain('run_command, run_command_batch, or playwright_run');
  });

  it('adds conversation/composer continuity guidance when relevant UI files changed', () => {
    const prompt = buildTesterPrompt({
      node: makeTask(),
      approvedPlan: 'Implement hotkeys and modal behavior',
      implementationResponse: 'Done',
      changedFiles: ['packages/ui/src/App.tsx', 'packages/ui/src/app/components/work/TimelinePanel.tsx'],
      validationResults: [],
      attempt: 1,
      uiChangesDetected: true,
      uiTestsRequired: true,
      screenshotEvidenceRequired: false,
      minScreenshotCount: 1,
      uiTestCommandPatterns: ['playwright', 'test:ui'],
    });

    expect(prompt).toContain('prompt input remains visible and usable after tester verdict emission');
  });
});