import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, listWorktrees } from '../src/worktree.js';

async function run(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const { exec } = await import('node:child_process');
  return new Promise((resolve) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: error && typeof (error as { code?: number }).code === 'number' ? (error as { code?: number }).code ?? 1 : 0,
      });
    });
  });
}

async function initRepo(root: string): Promise<void> {
  await run('git init -b main', root);
  await run('git config user.email "orchestrace@example.com"', root);
  await run('git config user.name "Orchestrace Test"', root);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf8');
  await run('git add README.md', root);
  await run('git commit -m "init"', root);
}

describe('createWorktree dependency bootstrap', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'orchestrace-sandbox-worktree-'));
    await initRepo(repoRoot);
  });

  it('skips install when no pnpm lockfile exists', async () => {
    const handle = await createWorktree(repoRoot, 'task-no-lockfile');
    try {
      const output = await run('git rev-parse --abbrev-ref HEAD', handle.path);
      expect(output.stdout.trim()).toBe('orchestrace/task-no-lockfile');
    } finally {
      await handle.cleanup();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('runs install and fails cleanly when pnpm lockfile exists but install cannot proceed', async () => {
    await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n', 'utf8');
    await run('git add pnpm-lock.yaml', repoRoot);
    await run('git commit -m "add lockfile"', repoRoot);

    await expect(createWorktree(repoRoot, 'task-install-fail')).rejects.toThrow('Dependency bootstrap failed');

    const worktrees = await listWorktrees(repoRoot);
    expect(worktrees.some((path) => path.includes('task-install-fail'))).toBe(false);

    const branchCheck = await run('git branch --list "orchestrace/task-install-fail"', repoRoot);
    expect(branchCheck.stdout.trim()).toBe('');

    await rm(repoRoot, { recursive: true, force: true });
  });

  it('skips install when node_modules already exists', async () => {
    await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n', 'utf8');
    await mkdir(join(repoRoot, 'node_modules'), { recursive: true });
    await writeFile(join(repoRoot, 'node_modules', '.orchestrace-test-marker'), 'ok\n', 'utf8');
    await run('git add pnpm-lock.yaml', repoRoot);
    await run('git add -f node_modules/.orchestrace-test-marker', repoRoot);
    await run('git commit -m "lockfile and deps"', repoRoot);

    const handle = await createWorktree(repoRoot, 'task-existing-node-modules');
    try {
      const output = await run('test -f node_modules/.orchestrace-test-marker && echo yes', handle.path);
      expect(output.stdout.trim()).toBe('yes');
    } finally {
      await handle.cleanup();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});