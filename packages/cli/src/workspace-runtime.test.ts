import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWorkspaceRuntimeIsComplete,
  formatMissingSourceDirsWarning,
  validateWorkspaceRuntime,
} from './workspace-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspaceLikeTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrace-cli-workspace-runtime-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'packages', 'tools', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'cli', 'tests'), { recursive: true });
  await mkdir(join(dir, 'packages', 'tools', 'tests'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"temp"}\n', 'utf8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
  await writeFile(join(dir, 'tsconfig.base.json'), '{}\n', 'utf8');
  await writeFile(join(dir, 'vitest.config.ts'), 'export default {}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'cli', 'src', 'runner.ts'), 'export {}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'cli', 'src', 'ui-server.ts'), 'export {}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'tools', 'src', 'index.ts'), 'export {}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'cli', 'tests', 'workspace-runtime.test.ts'), 'export {}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'tools', 'tests', 'toolset.test.ts'), 'export {}\n', 'utf8');
  return dir;
}

describe('workspace runtime validation', () => {
  it('normalizes valid workspace path and detects no missing expected dirs/critical files', async () => {
    const workspace = await makeWorkspaceLikeTree();

    const result = await validateWorkspaceRuntime(workspace);

    expect(result.normalizedPath.length).toBeGreaterThan(0);
    expect(result.missingExpectedDirs).toEqual([]);
    expect(result.missingCriticalPaths).toEqual([]);
    expect(() => assertWorkspaceRuntimeIsComplete(result)).not.toThrow();
  });

  it('reports missing expected source dirs for mount/worktree mismatch diagnostics', async () => {
    const workspace = await makeWorkspaceLikeTree();
    await rm(join(workspace, 'packages', 'tools'), { recursive: true, force: true });

    const result = await validateWorkspaceRuntime(workspace);
    const warning = formatMissingSourceDirsWarning(result.normalizedPath, result.missingExpectedDirs);

    expect(result.missingExpectedDirs).toContain('packages/tools/src');
    expect(warning).toContain('worktree/root mismatch or missing container bind mount');
  });

    it('does not require specific test filenames when test directories exist', async () => {
    const workspace = await makeWorkspaceLikeTree();
    await rm(join(workspace, 'packages', 'tools', 'tests', 'toolset.test.ts'), { force: true });

    const result = await validateWorkspaceRuntime(workspace);

    expect(result.missingCriticalPaths).toEqual([]);
    expect(() => assertWorkspaceRuntimeIsComplete(result)).not.toThrow();
  });

  it('returns missing critical paths when expected test directories are removed', async () => {
    const workspace = await makeWorkspaceLikeTree();
    await rm(join(workspace, 'packages', 'tools', 'tests'), { recursive: true, force: true });

    const result = await validateWorkspaceRuntime(workspace);

    expect(result.missingCriticalPaths).toContain('packages/tools/tests');
    expect(() => assertWorkspaceRuntimeIsComplete(result)).toThrow(
      'Workspace runtime check failed: critical source/test/config files missing under cwd',
    );
  });


  it('throws for inaccessible workspace paths', async () => {
    await expect(validateWorkspaceRuntime('/tmp/orchestrace-missing-workspace-path')).rejects.toThrow(
      'Workspace path is not accessible:',
    );
  });
});