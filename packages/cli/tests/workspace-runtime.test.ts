import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMissingSourceDirsWarning, validateWorkspaceRuntime } from '../src/workspace-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspaceLikeTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrace-cli-workspace-runtime-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'packages', 'tools', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
  return dir;
}

describe('workspace runtime validation', () => {
  it('normalizes valid workspace path and detects no missing expected dirs', async () => {
    const workspace = await makeWorkspaceLikeTree();

    const result = await validateWorkspaceRuntime(workspace);

    expect(result.normalizedPath.length).toBeGreaterThan(0);
    expect(result.missingExpectedDirs).toEqual([]);
  });

  it('reports missing expected source dirs for mount/worktree mismatch diagnostics', async () => {
    const workspace = await makeWorkspaceLikeTree();
    await rm(join(workspace, 'packages', 'tools'), { recursive: true, force: true });

    const result = await validateWorkspaceRuntime(workspace);
    const warning = formatMissingSourceDirsWarning(result.normalizedPath, result.missingExpectedDirs);

    expect(result.missingExpectedDirs).toContain('packages/tools/src');
    expect(warning).toContain('worktree/root mismatch or missing container bind mount');
  });

  it('throws for inaccessible workspace paths', async () => {
    await expect(validateWorkspaceRuntime('/tmp/orchestrace-missing-workspace-path')).rejects.toThrow(
      'Workspace path is not accessible:',
    );
  });
});