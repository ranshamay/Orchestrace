import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WORKTREE_LOCK_TTL_MS = 15 * 60_000;

export interface WorktreeLockMetadata {
  lockId: string;
  taskId: string;
  pid: number;
  host: string;
  createdAt: string;
}

export interface WorktreeStartupWarning {
  code: 'stale_lock_cleaned';
  message: string;
  previousOwner?: {
    pid: number;
    host: string;
    createdAt: string;
  };
}

export class WorktreeLockError extends Error {
  readonly lockPath: string;
  readonly worktreePath: string;
  readonly owner?: {
    pid: number;
    host: string;
    createdAt: string;
  };

  constructor(options: {
    message: string;
    lockPath: string;
    worktreePath: string;
    owner?: { pid: number; host: string; createdAt: string };
  }) {
    super(options.message);
    this.name = 'WorktreeLockError';
    this.lockPath = options.lockPath;
    this.worktreePath = options.worktreePath;
    this.owner = options.owner;
  }
}

export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** Non-fatal startup warnings emitted during setup. */
  warnings: WorktreeStartupWarning[];
  /** Clean up: remove worktree and delete the branch. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated git worktree for a task.
 * Each worktree gets its own branch so parallel agents can make
 * non-conflicting changes to the same repo.
 */
export async function createWorktree(
  repoRoot: string,
  taskId: string,
  baseBranch = 'HEAD',
  worktreeDir?: string,
): Promise<WorktreeHandle> {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const branch = `orchestrace/${sanitized}`;
  const dir = worktreeDir ?? join(repoRoot, '.worktrees');
  const worktreePath = join(dir, sanitized);
  const locksDir = join(dir, '.locks');
  const lockPath = join(locksDir, `${sanitized}.lock`);

  await mkdir(dir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  const warnings: WorktreeStartupWarning[] = [];
  const lock = await acquireWorktreeLock({ lockPath, worktreePath, taskId, warnings });

  try {
    // Create a new branch and worktree
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
  } catch (error) {
    await releaseWorktreeLockIfOwned(lockPath, lock.lockId).catch(() => {});
    throw error;
  }

  return {
    path: worktreePath,
    branch,
    warnings,
    async cleanup() {
      await git(repoRoot, ['worktree', 'remove', worktreePath, '--force']).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git(repoRoot, ['branch', '-D', branch]).catch(() => {});
      await releaseWorktreeLockIfOwned(lockPath, lock.lockId).catch(() => {});
    },
  };
}

/**
 * List all active worktrees.
 */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * Merge a worktree branch back into the target branch.
 */
export async function mergeWorktree(
  repoRoot: string,
  handle: WorktreeHandle,
  targetBranch = 'main',
): Promise<{ merged: boolean; conflicts: boolean }> {
  try {
    await git(repoRoot, ['checkout', targetBranch]);
    await git(repoRoot, ['merge', handle.branch, '--no-edit']);
    return { merged: true, conflicts: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('CONFLICT')) {
      return { merged: false, conflicts: true };
    }
    throw err;
  }
}

async function acquireWorktreeLock(options: {
  lockPath: string;
  worktreePath: string;
  taskId: string;
  warnings: WorktreeStartupWarning[];
}): Promise<WorktreeLockMetadata> {
  const lock: WorktreeLockMetadata = {
    lockId: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    taskId: options.taskId,
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(options.lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
      return lock;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const existing = await readLockMetadata(options.lockPath);
      const stale = await isStaleLock(existing, options.lockPath);
      if (!stale) {
        throw new WorktreeLockError({
          message: buildLockErrorMessage(existing),
          lockPath: options.lockPath,
          worktreePath: options.worktreePath,
          owner: existing
            ? {
              pid: existing.pid,
              host: existing.host,
              createdAt: existing.createdAt,
            }
            : undefined,
        });
      }

      const staleOwner = existing
        ? {
          pid: existing.pid,
          host: existing.host,
          createdAt: existing.createdAt,
        }
        : undefined;
      await unlink(options.lockPath).catch(() => {});
      options.warnings.push({
        code: 'stale_lock_cleaned',
        message: `Removed stale worktree lock for ${options.worktreePath}.`,
        previousOwner: staleOwner,
      });
    }
  }

  throw new WorktreeLockError({
    message: `Worktree is currently locked: ${options.worktreePath}`,
    lockPath: options.lockPath,
    worktreePath: options.worktreePath,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST');
}

function buildLockErrorMessage(metadata?: WorktreeLockMetadata): string {
  if (!metadata) {
    return 'Worktree is currently locked by another active session.';
  }

  return `Worktree is currently in use by another session (${metadata.host} pid ${metadata.pid}).`;
}

async function readLockMetadata(lockPath: string): Promise<WorktreeLockMetadata | undefined> {
  try {
    const contents = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(contents) as Partial<WorktreeLockMetadata>;
    if (
      typeof parsed.lockId !== 'string'
      || typeof parsed.taskId !== 'string'
      || typeof parsed.pid !== 'number'
      || typeof parsed.host !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) {
      return undefined;
    }

    return {
      lockId: parsed.lockId,
      taskId: parsed.taskId,
      pid: parsed.pid,
      host: parsed.host,
      createdAt: parsed.createdAt,
    };
  } catch {
    return undefined;
  }
}

async function isStaleLock(metadata: WorktreeLockMetadata | undefined, lockPath: string): Promise<boolean> {
  const lockAge = await readFileAge(lockPath);
  if (lockAge >= WORKTREE_LOCK_TTL_MS) {
    return true;
  }

  if (!metadata) {
    return false;
  }

  if (metadata.host !== hostname()) {
    return false;
  }

  return !isProcessAlive(metadata.pid);
}

async function readFileAge(path: string): Promise<number> {
  try {
    const fileStat = await stat(path);
    return Date.now() - fileStat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === 'EPERM') {
        return true;
      }
      if (code === 'ESRCH') {
        return false;
      }
    }

    return false;
  }
}

async function releaseWorktreeLockIfOwned(lockPath: string, lockId: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (!metadata || metadata.lockId !== lockId) {
    return;
  }

  await unlink(lockPath).catch(() => {});
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed:\n${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}