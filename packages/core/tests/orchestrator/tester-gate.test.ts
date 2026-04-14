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

const APPROVED_PLAN_WITH_CORE_TESTING = [
  'Implementation: Update feature behavior in changed modules.',
  'Testing: run unit tests for the touched modules.',
  'Testing: run integration tests for affected workflows.',
].join('\n');

const APPROVED_PLAN_WITH_UI_TESTING = [
  APPROVED_PLAN_WITH_CORE_TESTING,
  'Testing: run Playwright e2e checks for updated UI behavior and capture screenshots.',
].join('\n');

function makeTesterAgent(params: {
  verdict: Record<string, unknown>;
  commands: Array<{
    toolName?: 'run_command' | 'run_command_batch' | 'playwright_run';
    command: string;
    args?: string[];
    isError?: boolean;
  }>;
}): LlmAgent {
  const { verdict, commands } = params;

  return {
    async complete(
      _prompt: LlmPromptInput,
      _signal?: AbortSignal,
      options?: LlmCompletionOptions,
    ) {
      commands.forEach((entry, index) => {
        const toolName = entry.toolName ?? 'run_command';
        const toolCallId = `tool-${index + 1}`;
        const startedArgs = toolName === 'playwright_run'
          ? JSON.stringify({ command: entry.command, args: entry.args ?? [] })
          : JSON.stringify({ command: entry.command });
        options?.onToolCall?.({
          type: 'started',
          toolCallId,
          toolName,
          arguments: startedArgs,
        });
        options?.onToolCall?.({
          type: 'result',
          toolCallId,
          toolName,
          result: `ok: ${entry.command}`,
          isError: entry.isError ?? false,
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
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
        'VERIFY-ONLY: Run Playwright e2e smoke checks',
      ],
      testedAreas: ['unit', 'integration', 'ui', 'e2e'],
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
      approvedPlan: APPROVED_PLAN_WITH_UI_TESTING,
      implementationOutput: makeImplementationOutput(),
      testerAgent: makeTesterAgent({
        verdict,
        commands: [{ command: 'pnpm --filter @orchestrace/cli test' }],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
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
    expect(result.verdict.rejectionReason).toContain('Playwright e2e coverage');
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
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
        'VERIFY-ONLY: Run Playwright UI smoke tests and capture screenshots',
      ],
      testedAreas: ['unit', 'integration', 'ui', 'e2e'],
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
      approvedPlan: APPROVED_PLAN_WITH_UI_TESTING,
      implementationOutput: makeImplementationOutput(),
            testerAgent: makeTesterAgent({
        verdict,
        commands: [{ command: 'pnpm exec playwright test' }],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
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

  it('rejects when approved planner plan omits unit/integration testing guidance', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-plan-missing-tests-'));
    tempDirs.push(workspacePath);

    const verdict = {
      approved: true,
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
      ],
      testedAreas: ['unit', 'integration'],
      executedTestCommands: [
        'pnpm --filter @orchestrace/core test -- unit',
        'pnpm --filter @orchestrace/core test -- integration',
      ],
      testsPassed: 2,
      testsFailed: 0,
      coverageAssessment: 'Core behavior covered by unit and integration checks.',
      qualityAssessment: 'No regression indicators.',
      uiChangesDetected: false,
      uiTestsRequired: false,
      uiTestsRun: false,
      screenshotPaths: [],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: 'Implementation plan only: update UI flow and command wiring.',
      implementationOutput: makeImplementationOutput(),
      testerAgent: makeTesterAgent({
        verdict,
        commands: [
          { command: 'pnpm --filter @orchestrace/core test -- unit' },
          { command: 'pnpm --filter @orchestrace/core test -- integration' },
        ],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
      attempt: 1,
      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: false,
      requireUiScreenshots: false,
      minUiScreenshotCount: 1,
      uiChangesDetected: false,
      uiTestCommandPatterns: ['playwright'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(false);
    expect(result.verdict.rejectionReason).toContain('Approved planner plan is missing mandatory testing guidance');
  });

  it('treats playwright_run execution as satisfying requireRunTests', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-playwright-run-'));
    tempDirs.push(workspacePath);

    const verdict = {
      approved: true,
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
        'VERIFY-ONLY: Run focused UI check with Playwright',
      ],
      testedAreas: ['unit', 'integration', 'ui', 'e2e'],
      executedTestCommands: [
        'pnpm --filter @orchestrace/core test -- unit',
        'pnpm --filter @orchestrace/core test -- integration',
        'playwright test --grep @smoke',
      ],
      testsPassed: 1,
      testsFailed: 0,
      coverageAssessment: 'Focused smoke path validated.',
      qualityAssessment: 'No regressions observed in UI smoke path.',
      uiChangesDetected: false,
      uiTestsRequired: false,
      uiTestsRun: false,
      screenshotPaths: [],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: APPROVED_PLAN_WITH_CORE_TESTING,
      implementationOutput: makeImplementationOutput(),
            testerAgent: makeTesterAgent({
        verdict,
        commands: [
          { command: 'pnpm --filter @orchestrace/core test -- unit' },
          { command: 'pnpm --filter @orchestrace/core test -- integration' },
          { toolName: 'playwright_run', command: 'test', args: ['--grep', '@smoke'] },
        ],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
      attempt: 1,

      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: false,
      requireUiScreenshots: false,
      minUiScreenshotCount: 1,
      uiChangesDetected: false,
      uiTestCommandPatterns: ['playwright'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(true);
    expect(result.verdict.executedTestCommands).toContain('playwright test --grep @smoke');
  });

  it('rejects screenshot evidence paths under .orchestrace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-shot-scope-'));
    tempDirs.push(workspacePath);

    const screenshotDir = join(workspacePath, '.orchestrace', 'ui');
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(join(screenshotDir, 'home.png'), 'fake-image-content', 'utf-8');

    const verdict = {
      approved: true,
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
        'VERIFY-ONLY: Run UI smoke and capture evidence with Playwright',
      ],
      testedAreas: ['unit', 'integration', 'ui', 'e2e'],
      executedTestCommands: [
        'pnpm --filter @orchestrace/core test -- unit',
        'pnpm --filter @orchestrace/core test -- integration',
        'pnpm exec playwright test',
      ],
      testsPassed: 1,
      testsFailed: 0,
      coverageAssessment: 'UI flow exercised.',
      qualityAssessment: 'No functional regressions seen.',
      uiChangesDetected: true,
      uiTestsRequired: true,
      uiTestsRun: true,
      screenshotPaths: ['.orchestrace/ui/home.png'],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: APPROVED_PLAN_WITH_UI_TESTING,
      implementationOutput: makeImplementationOutput(),
            testerAgent: makeTesterAgent({
        verdict,
        commands: [
          { command: 'pnpm --filter @orchestrace/core test -- unit' },
          { command: 'pnpm --filter @orchestrace/core test -- integration' },
          { command: 'pnpm exec playwright test' },
        ],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
      attempt: 1,

      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: true,
      requireUiScreenshots: true,
      minUiScreenshotCount: 1,
      uiChangesDetected: true,
      uiTestCommandPatterns: ['playwright'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(false);
    expect(result.verdict.screenshotPaths).toEqual([]);
    expect(result.verdict.rejectionReason).toContain('at least 1 screenshot evidence');
    expect(result.verdict.suggestedFixes?.join('\n') ?? '').toContain('avoid .orchestrace');
  });

  it('does not accept failed playwright_run as successful UI test evidence', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'orchestrace-tester-gate-playwright-fail-'));
    tempDirs.push(workspacePath);

    const verdict = {
      approved: true,
      testPlan: [
        'VERIFY-ONLY: Run unit suite for changed modules',
        'VERIFY-ONLY: Run integration suite for changed workflows',
        'VERIFY-ONLY: Run Playwright smoke checks for updated UI behavior',
      ],
      testedAreas: ['unit', 'integration', 'ui', 'e2e'],
      executedTestCommands: [
        'pnpm --filter @orchestrace/core test -- unit',
        'pnpm --filter @orchestrace/core test -- integration',
        'playwright test --grep @smoke',
      ],
      testsPassed: 1,
      testsFailed: 0,
      coverageAssessment: 'Smoke path appears covered.',
      qualityAssessment: 'No obvious regressions from smoke path.',
      uiChangesDetected: true,
      uiTestsRequired: true,
      uiTestsRun: true,
      screenshotPaths: [],
      rejectionReason: '',
      suggestedFixes: [],
    };

    const result = await executeTesterRole({
      task: makeTask(),
      approvedPlan: APPROVED_PLAN_WITH_UI_TESTING,
      implementationOutput: makeImplementationOutput(),
            testerAgent: makeTesterAgent({
        verdict,
        commands: [
          {
            toolName: 'run_command',
            command: 'pnpm --filter @orchestrace/core test -- unit',
            isError: false,
          },
          {
            toolName: 'run_command',
            command: 'pnpm --filter @orchestrace/core test -- integration',
            isError: false,
          },
          {
            toolName: 'playwright_run',
            command: 'test',
            args: ['--grep', '@smoke'],
            isError: true,
          },
        ],
      }),
      testerModel: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
      testerSystemPrompt: 'You are tester.',
      attempt: 1,

      emit: () => undefined,
      requireRunTests: true,
      requireUiTests: true,
      requireUiScreenshots: false,
      minUiScreenshotCount: 1,
      uiChangesDetected: true,
      uiTestCommandPatterns: ['playwright'],
      workspacePath,
    });

    expect(result.verdict.approved).toBe(false);
    expect(result.verdict.uiTestsRun).toBe(false);
    expect(result.verdict.rejectionReason).toContain('Playwright e2e coverage');
  });
});
