import { describe, expect, it } from 'vitest';
import {
  createBranchFromBase,
  ensureCleanAndSyncedBaseBranch,
  type GitRunResult,
} from '../src/runner/branching.js';

describe('runner branching safeguards', () => {
  it('rejects delivery branch sync when worktree is dirty', async () => {
    const runGitCalls: Array<{ args: string[]; timeoutMs: number }> = [];

    await expect(ensureCleanAndSyncedBaseBranch({
      baseBranch: 'main',
      timeoutMs: 10_000,
      runGit: async (args, timeoutMs) => {
        runGitCalls.push({ args, timeoutMs });
        return { ok: true, stdout: '', stderr: '' };
      },
      getWorktreeDirtySummary: async () => ({
        hasUncommittedChanges: true,
        hasStagedChanges: false,
        hasUntrackedChanges: false,
        dirtySummary: ['M packages/cli/src/runner.ts'],
      }),
    })).rejects.toThrow('Working tree must be clean before syncing base branch for delivery.');

    expect(runGitCalls).toHaveLength(0);
  });

  it('fails with actionable error when ff-only pull fails', async () => {
    const calls: string[][] = [];

    await expect(ensureCleanAndSyncedBaseBranch({
      baseBranch: 'main',
      timeoutMs: 10_000,
      runGit: async (args): Promise<GitRunResult> => {
        calls.push(args);
        if (args[0] === 'pull') {
          return { ok: false, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
        }
        return { ok: true, stdout: '', stderr: '' };
      },
      getWorktreeDirtySummary: async () => ({
        hasUncommittedChanges: false,
        hasStagedChanges: false,
        hasUntrackedChanges: false,
        dirtySummary: [],
      }),
    })).rejects.toThrow('git pull --ff-only origin main failed: fatal: Not possible to fast-forward, aborting.');

    expect(calls).toEqual([
      ['fetch', 'origin'],
      ['checkout', 'main'],
      ['pull', '--ff-only', 'origin', 'main'],
    ]);
  });

  it('creates branch explicitly from synced base and falls back when preferred name fails', async () => {
    const calls: string[][] = [];

    const selected = await createBranchFromBase({
      preferredBranchName: 'feat/new-work',
      fallbackBranchName: 'orchestrace/session-abc123',
      baseBranch: 'main',
      timeoutMs: 10_000,
      runGit: async (args): Promise<GitRunResult> => {
        calls.push(args);
        if (args[2] === 'feat/new-work') {
          return { ok: false, stdout: '', stderr: 'branch exists' };
        }
        return { ok: true, stdout: '', stderr: '' };
      },
    });

    expect(selected).toBe('orchestrace/session-abc123');
    expect(calls).toEqual([
      ['checkout', '-B', 'feat/new-work', 'main'],
      ['checkout', '-B', 'orchestrace/session-abc123', 'main'],
    ]);
  });
});