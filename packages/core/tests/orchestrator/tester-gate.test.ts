import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmAgent, LlmCompletionOptions, LlmPromptInput } from '@orchestrace/provider';
import type { TaskNode, TaskOutput } from '../../src/dag/types.js';
import { executeTesterRole } from '../../src/orchestrator/role-executor.js';

function makeTask(): TaskNode {
  return {
    id: 'task',
    name: 'Implement feature',
    type: 'code',
    prompt: 'Implement requested change',
    dependencies: [],
  };
}

function makeImplementationOutput(): TaskOutput {
  return {
    taskId: 'task',
    status: 'completed',
    response: 'Implementation done',
    filesChanged: ['packages/ui/src/App.tsx'],
    durationMs: 10,
    retries: 0,
  };
}

function makeTesterAgent(params: {
  verdict: Record<string, unknown>;
  commands: string[];
}): LlmAgent {
  const { verdict, commands } = params;

  return {
    async complete(
      _prompt: LlmPromptInput,
      _signal?: AbortSignal,
      options?: LlmCompletionOptions,
    ) {
      commands.forEach((command, index) => {
        const toolCallId = `tool-${index + 1}`;
        options?.onToolCall?.({
          type: 'started',
          toolCallId,
          toolName: 'run_command',
          arguments: JSON.stringify({ command }),
        });
        options?.onToolCall?.({
          type: 'result',
          toolCallId,
          toolName: 'run_command',
          result: `ok: ${command}`,
          isError: false,
        });
      });

      return {
        text: JSON.stringify(verdict),
      };
    },
  };
}

describe('tester gate UI policy', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('rejects when UI changes require UI tests but no UI test command evidence exists', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-ui-cmd-'));
    tempDirs.push(workspacePath);

    const verdict = {
      approved: true,
      testPlan: ['Run existing regression suite'],
      testedAreas: ['unit', 'ui'],
      executedTestCommands: ['pnpm --filter @orchestrace/cli test'],
      testsPassed: 8,
      testsFailed: 0,
      coverageAssessment: 'Covered changed logic and regression paths.',
      qualityAssessment: 'No regression signals.',
      uiChangesDetected: true,
      uiTestsRequired: true,
      uiTestsRun: true,
      screenshotPaths: [],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: 'Update UI flow',
      implementationOutput: makeImplementationOutput(),
      testerAgent: makeTesterAgent({
        verdict,
        commands: ['pnpm --filter @orchestrace/cli test'],
      }),
      attempt: 1,
      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: true,
      requireUiScreenshots: false,
      minUiScreenshotCount: 2,
      uiChangesDetected: true,
      uiTestCommandPatterns: ['playwright', 'test:ui'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(false);
    expect(result.verdict.rejectionReason).toContain('no UI test command execution evidence');
    expect(result.verdict.uiTestsRequired).toBe(true);
    expect(result.verdict.uiTestsRun).toBe(false);
  });

  it('rejects when UI screenshot minimum is not met for UI changes', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-ui-shot-'));
    tempDirs.push(workspacePath);

    const screenshotDir = join(workspacePath, 'artifacts', 'ui');
    await mkdir(screenshotDir, { recursive: true });
    const screenshotPath = join(screenshotDir, 'home.png');
    await writeFile(screenshotPath, 'fake-image-content', 'utf-8');

    const verdict = {
      approved: true,
      testPlan: ['Run UI smoke tests and capture screenshots'],
      testedAreas: ['ui'],
      executedTestCommands: ['pnpm --filter @orchestrace/ui test:ui'],
      testsPassed: 3,
      testsFailed: 0,
      coverageAssessment: 'UI states covered by smoke suite.',
      qualityAssessment: 'Visual flow and interactions validated.',
      uiChangesDetected: true,
      uiTestsRequired: true,
      uiTestsRun: true,
      screenshotPaths: ['artifacts/ui/home.png'],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: 'Update UI flow',
      implementationOutput: makeImplementationOutput(),
      testerAgent: makeTesterAgent({
        verdict,
        commands: ['pnpm exec playwright test'],
      }),
      attempt: 1,
      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: true,
      requireUiScreenshots: true,
      minUiScreenshotCount: 2,
      uiChangesDetected: true,
      uiTestCommandPatterns: ['playwright', 'test:ui'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(false);
    expect(result.verdict.rejectionReason).toContain('at least 2 screenshot evidence');
    expect(result.verdict.screenshotPaths).toEqual(['artifacts/ui/home.png']);
    expect(result.verdict.uiTestsRun).toBe(true);
  });
});
