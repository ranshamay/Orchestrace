import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

    await rm(join(first.worktreePath, 'packages', 'tools', 'tests', 'toolset.test.ts'), { force: true });

    const second = await ensureSessionWorktree({ repoRoot, sessionId });
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branchName).toBe(first.branchName);
    expect(second.created).toBe(false);
    expect(second.recreated).toBe(false);

    await cleanupSessionWorktree({ repoRoot, sessionId });
    expect(await pathExists(first.worktreePath)).toBe(false);
  });


  it('self-heals an existing session worktree when critical files were deleted', async () => {
    const repoRoot = await createTempRepoWithOrigin();
    const sessionId = 'session-heal';

    const first = await ensureSessionWorktree({ repoRoot, sessionId });
    await rm(join(first.worktreePath, 'packages', 'tools', 'src', 'index.ts'), { force: true });

    const healed = await ensureSessionWorktree({ repoRoot, sessionId });

    expect(healed.created).toBe(false);
    expect(healed.recreated).toBe(true);
    expect(await pathExists(join(healed.worktreePath, 'packages', 'tools', 'src', 'index.ts'))).toBe(true);

    await cleanupSessionWorktree({ repoRoot, sessionId });
  });
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-session-worktree-repo-'));
  tempDirs.push(repoRoot);
  await git(repoRoot, ['init', '-b', 'main']);
  await git(repoRoot, ['config', 'user.email', 'orchestrace-tests@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Orchestrace Tests']);
  await mkdir(join(repoRoot, 'packages', 'cli', 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'tools', 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'cli', 'tests'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'tools', 'tests'), { recursive: true });
  await writeFile(join(repoRoot, 'README.md'), '# temp\n', 'utf8');
  await writeFile(join(repoRoot, 'package.json'), '{"name":"temp"}\n', 'utf8');
  await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
  await writeFile(join(repoRoot, 'tsconfig.base.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'vitest.config.ts'), 'export default {}\n', 'utf8');
  await writeFile(join(repoRoot, 'packages', 'cli', 'src', 'runner.ts'), 'export {}\n', 'utf8');
  await writeFile(join(repoRoot, 'packages', 'cli', 'src', 'ui-server.ts'), 'export {}\n', 'utf8');
  await writeFile(join(repoRoot, 'packages', 'tools', 'src', 'index.ts'), 'export {}\n', 'utf8');
  await writeFile(join(repoRoot, 'packages', 'cli', 'tests', 'workspace-runtime.test.ts'), 'export {}\n', 'utf8');
  await writeFile(join(repoRoot, 'packages', 'tools', 'tests', 'toolset.test.ts'), 'export {}\n', 'utf8');
  await git(repoRoot, ['add', '.']);
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