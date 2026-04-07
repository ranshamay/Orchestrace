import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { createWorktree, WorktreeLockError } from '../src/worktree.js';

const execFileAsync = promisify(execFile);
const reposToClean: string[] = [];

afterEach(async () => {
  await Promise.all(reposToClean.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-sandbox-worktree-'));
  reposToClean.push(repoRoot);

  await runGit(repoRoot, ['init']);
  await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
  await runGit(repoRoot, ['config', 'user.name', 'Test User']);
  await writeFile(join(repoRoot, 'README.md'), 'seed\n', 'utf8');
  await runGit(repoRoot, ['add', 'README.md']);
  await runGit(repoRoot, ['commit', '-m', 'init']);

  return repoRoot;
}

describe('createWorktree locking', () => {
  test('prevents second lock acquisition for same task path', async () => {
    const repoRoot = await createTempRepo();
    const first = await createWorktree(repoRoot, 'session-contention');

    await expect(createWorktree(repoRoot, 'session-contention')).rejects.toBeInstanceOf(WorktreeLockError);

    await first.cleanup();
  });

  test('cleans stale lock and emits warning', async () => {
    const repoRoot = await createTempRepo();
    const lockDir = join(repoRoot, '.worktrees', '.locks');
    await mkdir(lockDir, { recursive: true });

    const lockPath = join(lockDir, 'session-stale.lock');
    await writeFile(lockPath, `${JSON.stringify({
      lockId: 'stale-lock',
      taskId: 'session-stale',
      pid: 9_999_999,
      host: hostname(),
      createdAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    })}\n`, 'utf8');

    const handle = await createWorktree(repoRoot, 'session-stale');
    expect(handle.warnings.some((warning) => warning.code === 'stale_lock_cleaned')).toBe(true);

    await handle.cleanup();
  });

  test('cleanup only releases owned lock', async () => {
    const repoRoot = await createTempRepo();
    const handle = await createWorktree(repoRoot, 'session-owner');

    const lockPath = join(repoRoot, '.worktrees', '.locks', 'session-owner.lock');
    await writeFile(lockPath, `${JSON.stringify({
      lockId: 'foreign-lock-id',
      taskId: 'session-owner',
      pid: process.pid,
      host: hostname(),
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');

    await handle.cleanup();

    const lockStats = await stat(lockPath);
    expect(lockStats.isFile()).toBe(true);

    await unlink(lockPath);
  });

  test('session ID–derived task yields unique path/branch', async () => {
    const repoRoot = await createTempRepo();

    const first = await createWorktree(repoRoot, 'session-1111');
    const second = await createWorktree(repoRoot, 'session-2222');

    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);

    await second.cleanup();
    await first.cleanup();
  });
});