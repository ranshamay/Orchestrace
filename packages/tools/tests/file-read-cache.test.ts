import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionFileReadCache } from '../src/file-read-cache.js';
import { readFullFileWithCache } from '../src/file-read-cache.js';
import { createAgentToolset } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrace-cache-tests-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'file.ts'), 'export const value = 1;\n', 'utf-8');
  return dir;
}

async function waitForMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('file read cache', () => {
  it('covers miss, hit, and invalidation when file metadata changes', async () => {
    const cwd = await makeWorkspace();
    const targetPath = join(cwd, 'src', 'file.ts');
    const cache: SessionFileReadCache = new Map();

    const first = await readFullFileWithCache(targetPath, { cache });
    const entryAfterFirst = cache.get(targetPath);

    const second = await readFullFileWithCache(targetPath, { cache });
    const entryAfterSecond = cache.get(targetPath);

    await waitForMtimeTick();
    await writeFile(targetPath, 'export const value = 100;\n', 'utf-8');

    const third = await readFullFileWithCache(targetPath, { cache });
    const entryAfterThird = cache.get(targetPath);

    expect(first).toContain('value = 1');
    expect(second).toBe(first);
    expect(entryAfterSecond).toBe(entryAfterFirst);

    expect(third).toContain('value = 100');
    expect(entryAfterThird).toBeDefined();
    expect(entryAfterThird).not.toBe(entryAfterSecond);
    expect(entryAfterThird?.content).toContain('value = 100');
  });
});

describe('subagent snippet cache reuse', () => {
  it('reuses cached snippet reads across repeated subagent batch calls', async () => {
    const cwd = await makeWorkspace();
    const targetPath = join(cwd, 'src', 'file.ts');
    const delegatedPrompts: string[] = [];
    const cache: SessionFileReadCache = new Map();

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g-cache',
      taskId: 't-cache',
      fileReadCache: cache,
      runSubAgent: async (request) => {
        delegatedPrompts.push(request.prompt);
        return { text: 'ok' };
      },
    });

    const first = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'n1', prompt: 'Review src/file.ts for exports.' }],
      },
    });
    const readAtAfterFirst = cache.get(targetPath)?.readAt;

    const second = await toolset.executeTool({
      id: '2',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'n2', prompt: 'Review src/file.ts for exports again.' }],
      },
    });
    const readAtAfterSecond = cache.get(targetPath)?.readAt;

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(delegatedPrompts).toHaveLength(2);
    expect(delegatedPrompts[0]).toContain('[Auto-included file snippets]');
    expect(delegatedPrompts[1]).toContain('File: src/file.ts');

    expect(readAtAfterFirst).toBeDefined();
    expect(readAtAfterSecond).toBe(readAtAfterFirst);
  });

  it('logs structured warning when direct file-read fallback fails with a non-retriable category', async () => {
    const cwd = await makeWorkspace();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g-cache-log',
        taskId: 't-cache-log',
        runSubAgent: async () => ({ text: 'ok' }),
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [{ nodeId: 'n1', prompt: 'Inspect src/missing.ts for exports.' }],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('direct file-read fallback failed (bounded single-pass)'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('path=src/missing.ts'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('category=missing_data'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});