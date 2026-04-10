import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorktree, ensureWorktreeExists } from '../src/worktree-manager.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const REQUIRED_PATHS = ['README.md'];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
});

describe('worktree manager', () => {
  it('creates a managed worktree and reuses it on subsequent ensure calls', async () => {
    const repoRoot = await createTempRepoWithOrigin();
    const worktreePath = join(repoRoot, '.managed-worktrees', 'session-1');
    const branchName = 'orchestrace/session-1';

    const first = await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });
    expect(first.created).toBe(true);
    expect(first.recreated).toBe(true);
    expect(await pathExists(worktreePath)).toBe(true);
    expect((await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branchName);
    expect((await git(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim()).toBe('origin/main');

    const second = await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });
    expect(second.created).toBe(false);
    expect(second.recreated).toBe(false);
    expect(second.path).toBe(first.path);

    await cleanupWorktree({ repoPath: repoRoot, worktreePath, branchName });
    expect(await pathExists(worktreePath)).toBe(false);
    expect((await git(repoRoot, ['branch', '--list', branchName])).trim()).toBe('');
  });

  it('recreates a missing worktree path when the branch already exists', async () => {
    const repoRoot = await createTempRepo();
    const worktreePath = join(repoRoot, '.managed-worktrees', 'session-2');
    const branchName = 'orchestrace/session-2';

    await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });
    await git(repoRoot, ['worktree', 'remove', worktreePath, '--force']);

    const recreated = await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });
    expect(recreated.created).toBe(false);
    expect(recreated.recreated).toBe(true);
    expect(await pathExists(worktreePath)).toBe(true);

    await cleanupWorktree({ repoPath: repoRoot, worktreePath, branchName });
  });

    it('recreates an existing registered worktree when required files are missing', async () => {
    const repoRoot = await createTempRepoWithOrigin();
    const worktreePath = join(repoRoot, '.managed-worktrees', 'session-3');
    const branchName = 'orchestrace/session-3';

    await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });

    await rm(join(worktreePath, 'README.md'), { force: true });

    const healed = await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });

    expect(healed.created).toBe(false);
    expect(healed.recreated).toBe(true);
    expect(await pathExists(join(worktreePath, 'README.md'))).toBe(true);

    await cleanupWorktree({ repoPath: repoRoot, worktreePath, branchName });
  });

  it('recreates a registered worktree when it is on a different branch than expected', async () => {
    const repoRoot = await createTempRepoWithOrigin();
    const worktreePath = join(repoRoot, '.managed-worktrees', 'session-4');
    const branchName = 'orchestrace/session-4';

    await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });

    await git(worktreePath, ['checkout', '-B', 'orchestrace/foreign-session']);

    const healed = await ensureWorktreeExists({
      repoPath: repoRoot,
      branchName,
      worktreePath,
      baseRef: 'HEAD',
      requiredPaths: REQUIRED_PATHS,
    });

    expect(healed.created).toBe(false);
    expect(healed.recreated).toBe(true);
    expect((await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branchName);

    await cleanupWorktree({ repoPath: repoRoot, worktreePath, branchName });
  });
});


async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-worktree-manager-'));
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
  const remoteRoot = await mkdtemp(join(tmpdir(), 'orchestrace-worktree-manager-remote-'));
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