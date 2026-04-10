import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';


import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceIsClean,
  classifyWorkspacePathSessionIdRelation,
  cleanupReusedWorktree,
    resolveRunnerTaskRouteEnvValue,
  resolvePreSessionCleanupModeEnvValue,
} from '../src/ui-server.js';





const execFileAsync = promisify(execFile);

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

describe('worktree assignment helpers', () => {
  it('classifies matching session id in workspace path', () => {
    const result = classifyWorkspacePathSessionIdRelation(
      '8e4734f4-1111-2222-3333-444455556666',
      '/repo/.worktrees/session-8e4734f4-1111-2222-3333-444455556666',
    );
    expect(result.relation).toBe('match');
    expect(result.pathSessionId).toBe('8e4734f4-1111-2222-3333-444455556666');
  });

  it('classifies mismatched session id in workspace path', () => {
    const result = classifyWorkspacePathSessionIdRelation(
      '8e4734f4-1111-2222-3333-444455556666',
      '/repo/.worktrees/session-a3f297a1-7777-8888-9999-000011112222',
    );
    expect(result.relation).toBe('mismatch');
    expect(result.pathSessionId).toBe('a3f297a1-7777-8888-9999-000011112222');
  });

  it('returns none when workspace path has no session token', () => {
    const result = classifyWorkspacePathSessionIdRelation('abc', '/repo/.worktrees/feature-branch');
    expect(result.relation).toBe('none');
    expect(result.pathSessionId).toBeUndefined();
  });

  it('throws when workspace is dirty at session start', async () => {
    await expect(
      assertWorkspaceIsClean('/repo/.worktrees/session-abc', async () => ({
        hasUncommittedChanges: true,
        hasStagedChanges: false,
        hasUntrackedChanges: true,
        dirtySummary: ['M package.json', '?? temp.txt'],
      })),
    ).rejects.toThrow(/Workspace is not clean at session start/);
  });

    it('passes when workspace is clean at session start', async () => {
    await expect(
      assertWorkspaceIsClean('/repo/.worktrees/session-abc', async () => ({
        hasUncommittedChanges: false,
        hasStagedChanges: false,
        hasUntrackedChanges: false,
        dirtySummary: [],
      })),
    ).resolves.toBeUndefined();
  });

  it('resolves runner task route env with safe fallback when override is missing/invalid', () => {
    expect(resolveRunnerTaskRouteEnvValue(undefined)).toBe('code_change');
    expect(resolveRunnerTaskRouteEnvValue('')).toBe('code_change');
    expect(resolveRunnerTaskRouteEnvValue('not_a_route')).toBe('code_change');
  });

    it('preserves valid runner task route overrides', () => {
    expect(resolveRunnerTaskRouteEnvValue('shell_command')).toBe('shell_command');
    expect(resolveRunnerTaskRouteEnvValue(' investigation ')).toBe('investigation');
    expect(resolveRunnerTaskRouteEnvValue('refactor')).toBe('refactor');
  });

  it('resolves pre-session cleanup mode with safe fallback', () => {
    expect(resolvePreSessionCleanupModeEnvValue(undefined)).toBe('abort');
    expect(resolvePreSessionCleanupModeEnvValue('')).toBe('abort');
    expect(resolvePreSessionCleanupModeEnvValue('invalid')).toBe('abort');
    expect(resolvePreSessionCleanupModeEnvValue('invalid', 'stash')).toBe('stash');
  });

  it('preserves valid pre-session cleanup mode overrides', () => {
    expect(resolvePreSessionCleanupModeEnvValue('abort')).toBe('abort');
    expect(resolvePreSessionCleanupModeEnvValue('stash')).toBe('stash');
    expect(resolvePreSessionCleanupModeEnvValue(' warn ')).toBe('warn');
  });

  it('cleans reused worktree without checking out default branch directly', async () => {


    const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-worktree-cleanup-'));

    try {
      await gitExec(repoRoot, ['init']);
      await gitExec(repoRoot, ['config', 'user.email', 'orchestrace-tests@example.com']);
      await gitExec(repoRoot, ['config', 'user.name', 'Orchestrace Tests']);

      await writeFile(join(repoRoot, 'README.md'), '# temp\n', 'utf-8');
      await gitExec(repoRoot, ['add', 'README.md']);
      await gitExec(repoRoot, ['commit', '-m', 'init']);
      await gitExec(repoRoot, ['branch', '-M', 'main']);

      const worktreePath = join(repoRoot, '.worktrees', 'reused');
      await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
      await gitExec(repoRoot, ['worktree', 'add', '-b', 'session/reused', worktreePath, 'HEAD']);

      await writeFile(join(worktreePath, 'temp-file.txt'), 'temp\n', 'utf-8');
      const dirtyBefore = await gitExec(worktreePath, ['status', '--porcelain']);
      expect(dirtyBefore).toContain('temp-file.txt');

      const cleanup = await cleanupReusedWorktree(repoRoot, worktreePath);
      expect(cleanup.defaultBranch).toBe('main');

      const branchAfter = (await gitExec(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      expect(branchAfter).toBe('HEAD');

      const dirtyAfter = (await gitExec(worktreePath, ['status', '--porcelain'])).trim();
      expect(dirtyAfter).toBe('');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});