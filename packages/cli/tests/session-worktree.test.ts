import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupSessionWorktree,
  ensureSessionWorktree,
  resolveSessionWorktreeBranch,
  resolveSessionWorktreePath,
} from '../src/session-worktree.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

let previousWorktreeDir = process.env.ORCHESTRACE_WORKTREE_DIR;

beforeEach(async () => {
  previousWorktreeDir = process.env.ORCHESTRACE_WORKTREE_DIR;
  const baseDir = await mkdtemp(join(tmpdir(), 'orchestrace-session-worktrees-'));
  tempDirs.push(baseDir);
  process.env.ORCHESTRACE_WORKTREE_DIR = join(baseDir, 'managed-worktrees');
});

afterEach(async () => {
  if (previousWorktreeDir === undefined) {
    delete process.env.ORCHESTRACE_WORKTREE_DIR;
  } else {
    process.env.ORCHESTRACE_WORKTREE_DIR = previousWorktreeDir;
  }

  await Promise.all(tempDirs.splice(0, tempDirs.length).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
});

describe('session worktree helper', () => {
  it('defaults managed worktrees under repo-local .worktrees when override is unset', async () => {
    const repoRoot = await createTempRepo();
    const sessionId = 'session-local-default';

    const previous = process.env.ORCHESTRACE_WORKTREE_DIR;
    delete process.env.ORCHESTRACE_WORKTREE_DIR;
    try {
      const resolved = resolveSessionWorktreePath(repoRoot, sessionId);
      const expectedBase = join(repoRoot, '.worktrees');
      const comparableResolved = normalizeComparablePath(resolved);
      const comparableExpectedBase = normalizeComparablePath(expectedBase);
      expect(comparableResolved.startsWith(join(comparableExpectedBase, ''))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ORCHESTRACE_WORKTREE_DIR;
      } else {
        process.env.ORCHESTRACE_WORKTREE_DIR = previous;
      }
    }
  });

  it('creates a deterministic managed worktree and reuses it for retry', async () => {
    const repoRoot = await createTempRepoWithOrigin();
    const sessionId = 'session-123';

    const first = await ensureSessionWorktree({ repoRoot, sessionId });
    expect(first.worktreePath).toBe(resolveSessionWorktreePath(repoRoot, sessionId));
    expect(first.branchName).toBe(resolveSessionWorktreeBranch(sessionId));
    expect(first.created).toBe(true);
    expect(await pathExists(first.worktreePath)).toBe(true);
    expect((await git(first.worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim()).toBe('origin/main');

    const second = await ensureSessionWorktree({ repoRoot, sessionId });
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branchName).toBe(first.branchName);
    expect(second.created).toBe(false);
    expect(second.recreated).toBe(false);

    await cleanupSessionWorktree({ repoRoot, sessionId });
    expect(await pathExists(first.worktreePath)).toBe(false);
  });
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-session-worktree-repo-'));
  tempDirs.push(repoRoot);
  await git(repoRoot, ['init', '-b', 'main']);
  await git(repoRoot, ['config', 'user.email', 'orchestrace-tests@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Orchestrace Tests']);
  await writeFile(join(repoRoot, 'README.md'), '# temp\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'init']);
  return repoRoot;
}

async function createTempRepoWithOrigin(): Promise<string> {
  const remoteRoot = await mkdtemp(join(tmpdir(), 'orchestrace-session-worktree-remote-'));
  tempDirs.push(remoteRoot);
  await git(remoteRoot, ['init', '--bare']);

  const repoRoot = await createTempRepo();
  await git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(repoRoot, ['push', '-u', 'origin', 'main']);

  return repoRoot;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeComparablePath(path: string): string {
  return path.replace(/^\/private(?=\/var\/)/, '');
}