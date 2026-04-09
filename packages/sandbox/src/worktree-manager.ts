import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKTREE_CREATION_LOCKS = new Map<string, Promise<void>>();

export interface ManagedWorktree {
  path: string;
  branch: string;
  created: boolean;
  recreated: boolean;
}

export interface EnsureWorktreeOptions {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  baseRef?: string;
  bootstrapDependencies?: boolean;
}

export interface CleanupWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branchName?: string;
}

type NativeGitWorktree = {
  path: string;
  branch?: string;
  detached: boolean;
};

export function resolveManagedWorktreeBaseDir(repoPath: string): string {
  const override = process.env.ORCHESTRACE_WORKTREE_DIR?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(repoPath, override);
  }

  return join(resolve(repoPath), '.worktrees');
}

export async function ensureWorktreeExists(options: EnsureWorktreeOptions): Promise<ManagedWorktree> {
  const repoPath = resolve(options.repoPath);
  const worktreePath = resolve(options.worktreePath);
  const branchName = options.branchName.trim();
  const baseRef = options.baseRef?.trim() || 'HEAD';

  return withWorktreeCreationLock(worktreePath, async () => {
    if (await isWorktreeProperlySetUp(repoPath, worktreePath)) {
      if (options.bootstrapDependencies !== false) {
        await ensureWorktreeDependenciesInstalled(worktreePath);
      }
      return {
        path: worktreePath,
        branch: branchName,
        created: false,
        recreated: false,
      };
    }

    const branchAlreadyExists = await branchExists(repoPath, branchName);

    await recreateWorktreeInternal({
      repoPath,
      branchName,
      worktreePath,
      baseRef,
      createBranch: !branchAlreadyExists,
    });

    if (options.bootstrapDependencies !== false) {
      await ensureWorktreeDependenciesInstalled(worktreePath);
    }

    return {
      path: worktreePath,
      branch: branchName,
      created: !branchAlreadyExists,
      recreated: true,
    };
  });
}

export async function cleanupWorktree(options: CleanupWorktreeOptions): Promise<void> {
  const repoPath = resolve(options.repoPath);
  const worktreePath = resolve(options.worktreePath);

  await withWorktreeCreationLock(worktreePath, async () => {
    await comprehensiveWorktreeCleanup(repoPath, worktreePath);
    if (options.branchName?.trim()) {
      await gitSafe(repoPath, ['branch', '-D', options.branchName.trim()]);
    }
  });
}

export async function listWorktrees(repoPath: string): Promise<NativeGitWorktree[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

  const worktrees: NativeGitWorktree[] = [];
  let current: NativeGitWorktree | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.path) {
        worktrees.push(current);
      }
      current = undefined;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.path) {
        worktrees.push(current);
      }
      current = {
        path: resolve(line.slice('worktree '.length)),
        detached: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('branch ')) {
      const rawBranch = line.slice('branch '.length);
      current.branch = rawBranch.startsWith('refs/heads/')
        ? rawBranch.slice('refs/heads/'.length)
        : rawBranch;
      continue;
    }

    if (line === 'detached') {
      current.detached = true;
    }
  }

  if (current?.path) {
    worktrees.push(current);
  }

  return worktrees;
}

export async function ensureWorktreeDependenciesInstalled(worktreePath: string): Promise<void> {
  const lockfilePath = join(worktreePath, 'pnpm-lock.yaml');
  const nodeModulesPath = join(worktreePath, 'node_modules');

  if (!(await pathExists(lockfilePath))) {
    return;
  }

  if (await pathExists(nodeModulesPath)) {
    return;
  }

  try {
    await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: worktreePath,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to bootstrap worktree dependencies at ${worktreePath}: ${message}`);
  }
}

async function recreateWorktreeInternal(options: {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  baseRef: string;
  createBranch: boolean;
}): Promise<void> {
  await comprehensiveWorktreeCleanup(options.repoPath, options.worktreePath);

  const parent = dirname(options.worktreePath);
  await mkdir(parent, { recursive: true });

  await createWorktreeWithRetry(options);
}

async function createWorktreeWithRetry(options: {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  baseRef: string;
  createBranch: boolean;
}): Promise<void> {
  try {
    await addWorktree(options);
  } catch (error) {
    await forceCleanupWorktreeMetadata(options.repoPath, options.worktreePath);
    await rm(options.worktreePath, { recursive: true, force: true }).catch(() => {});
    try {
      await addWorktree(options);
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`Failed to create worktree ${options.worktreePath}: ${message}`);
    }
  }

  if (!(await pathExists(options.worktreePath))) {
    throw new Error(`Worktree creation reported success but path does not exist: ${options.worktreePath}`);
  }
}

async function addWorktree(options: {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  baseRef: string;
  createBranch: boolean;
}): Promise<void> {
  const args = options.createBranch
    ? ['worktree', 'add', '-b', options.branchName, options.worktreePath, options.baseRef]
    : ['worktree', 'add', options.worktreePath, options.branchName];
  await git(options.repoPath, args);
}

async function isWorktreeProperlySetUp(repoPath: string, worktreePath: string): Promise<boolean> {
  if (!(await pathExists(worktreePath))) {
    return false;
  }

  const registeredWorktrees = await listWorktrees(repoPath);
  const targetPath = await resolveComparablePath(worktreePath);
  for (const entry of registeredWorktrees) {
    if ((await resolveComparablePath(entry.path)) === targetPath) {
      return true;
    }
  }

  return false;
}

async function comprehensiveWorktreeCleanup(repoPath: string, worktreePath: string): Promise<void> {
  await gitSafe(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  await forceCleanupWorktreeMetadata(repoPath, worktreePath);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  await gitSafe(repoPath, ['worktree', 'prune']);
}

async function forceCleanupWorktreeMetadata(repoPath: string, worktreePath: string): Promise<void> {
  const commonDir = await getGitCommonDir(repoPath);
  const worktreeAdminName = await findWorktreeAdminName(commonDir, worktreePath);
  if (!worktreeAdminName) {
    return;
  }

  await rm(join(commonDir, 'worktrees', worktreeAdminName), { recursive: true, force: true });
}

async function findWorktreeAdminName(commonDir: string, worktreePath: string): Promise<string | undefined> {
  const metadataRoot = join(commonDir, 'worktrees');
  let entries: Dirent<string>[];
  try {
    entries = await readdir(metadataRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }

  const targetPath = await resolveComparablePath(worktreePath);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const gitdirPath = join(metadataRoot, entry.name, 'gitdir');
    if (!(await pathExists(gitdirPath))) {
      continue;
    }

    const rawGitdir = (await readFile(gitdirPath, 'utf8')).trim();
    if (!rawGitdir) {
      continue;
    }

    const resolvedGitdir = isAbsolute(rawGitdir)
      ? rawGitdir
      : resolve(join(metadataRoot, entry.name), rawGitdir);
    const candidatePath = await resolveComparablePath(dirname(resolvedGitdir));
    if (candidatePath === targetPath) {
      return entry.name;
    }
  }

  return undefined;
}

async function getGitCommonDir(repoPath: string): Promise<string> {
  const output = await git(repoPath, ['rev-parse', '--git-common-dir']);
  return isAbsolute(output) ? output : resolve(repoPath, output);
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  const result = await gitSafe(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
  return result.ok;
}

async function withWorktreeCreationLock<T>(worktreePath: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(worktreePath);
  const tail = WORKTREE_CREATION_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const slot = tail
    .catch(() => {})
    .then(() => gate);
  WORKTREE_CREATION_LOCKS.set(key, slot);

  await tail.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (WORKTREE_CREATION_LOCKS.get(key) === slot) {
      WORKTREE_CREATION_LOCKS.delete(key);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveComparablePath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  try {
    return await realpath(resolvedPath);
  } catch {
    const parent = dirname(resolvedPath);
    try {
      return join(await realpath(parent), basename(resolvedPath));
    } catch {
      return resolvedPath;
    }
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function gitSafe(
  repoPath: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT',
  );
}