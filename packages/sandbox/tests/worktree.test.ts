import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorktree, WorktreeLockError } from '../src/worktree.js';
import { execFile } from 'node:child_process';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0, createdDirs.length).map(async (dir) => {
    await fsRm(dir);
  }));
});

describe('createWorktree lock flow', () => {
  it('prevents second lock acquisition for same session worktree until cleanup', async () => {
    const repoRoot = await createTempRepo();

    const first = await createWorktree(repoRoot, 'session-abc');
    await expect(createWorktree(repoRoot, 'session-abc')).rejects.toBeInstanceOf(WorktreeLockError);

    await first.cleanup();

    const second = await createWorktree(repoRoot, 'session-abc');
    await second.cleanup();
  });

  it('cleanup only releases owned lock', async () => {
    const repoRoot = await createTempRepo();

    const first = await createWorktree(repoRoot, 'session-owned');

    // Simulate another process replacing lock ownership while worktree still exists.
    const lockPath = join(repoRoot, '.worktrees', '.locks', 'session-owned.lock');
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      lockId: 'different-lock-id',
      taskId: 'session-owned',
      sanitizedTaskId: 'session-owned',
      repoRoot,
      worktreeDir: join(repoRoot, '.worktrees'),
      worktreePath: join(repoRoot, '.worktrees', 'session-owned'),
      branch: 'orchestrace/session-owned',
      baseBranch: 'HEAD',
      owner: {
        pid: process.pid,
        host: 'localhost',
      },
      createdAt: new Date().toISOString(),
    }), 'utf8');

    await first.cleanup();

    await expect(createWorktree(repoRoot, 'session-owned')).rejects.toBeInstanceOf(WorktreeLockError);
  });

  it('cleans stale lock and returns warning', async () => {
    const repoRoot = await createTempRepo();
    const lockPath = join(repoRoot, '.worktrees', '.locks', 'session-stale.lock');
    await mkdir(join(repoRoot, '.worktrees', '.locks'), { recursive: true });

    await writeFile(lockPath, JSON.stringify({
      version: 1,
      lockId: 'stale-lock-id',
      taskId: 'session-stale',
      sanitizedTaskId: 'session-stale',
      repoRoot,
      worktreeDir: join(repoRoot, '.worktrees'),
      worktreePath: join(repoRoot, '.worktrees', 'session-stale'),
      branch: 'orchestrace/session-stale',
      baseBranch: 'HEAD',
      owner: {
        pid: 999999,
        host: 'non-existent-host',
      },
      createdAt: new Date(Date.now() - (16 * 60 * 1000)).toISOString(),
    }), 'utf8');

    const handle = await createWorktree(repoRoot, 'session-stale');

    expect(handle.warnings?.some((warning) => warning.code === 'stale_lock_cleaned')).toBe(true);

    await handle.cleanup();
  });
});

async function createTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrace-sandbox-'));
  createdDirs.push(root);
  await runGit(['init'], root);
  await runGit(['config', 'user.email', 'test@example.com'], root);
  await runGit(['config', 'user.name', 'Test User'], root);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf8');
  await runGit(['add', 'README.md'], root);
  await runGit(['commit', '-m', 'init'], root);
  return root;
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

async function fsRm(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { recursive: true, force: true });
}