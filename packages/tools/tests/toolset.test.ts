import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentToolset } from '../src/index.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrace-tools-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'file.ts'), 'export const value = 1;\n', 'utf-8');
  return dir;
}

function toolNames(toolset: ReturnType<typeof createAgentToolset>): string[] {
  return toolset.tools.map((tool) => tool.name).sort();
}

describe('createAgentToolset phase policy', () => {
  it('exposes read-only required tools for planning', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    expect(toolNames(toolset)).toEqual([
      'git_diff',
      'list_directory',
      'read_file',
      'search_files',
    ]);
  });

  it('exposes read-only required tools for chat', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'chat', taskType: 'code' });

    expect(toolNames(toolset)).toEqual([
      'git_diff',
      'list_directory',
      'read_file',
      'search_files',
    ]);
  });

  it('exposes implementation tools including git_status and run_command', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    expect(toolNames(toolset)).toEqual([
      'edit_file',
      'git_diff',
      'git_status',
      'list_directory',
      'read_file',
      'run_command',
      'search_files',
      'write_file',
    ]);
  });
});

describe('git_status tool', () => {
  it('returns status output in a git repository', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const init = await toolset.executeTool({ id: '1', name: 'run_command', arguments: { command: 'git init' } });
    expect(init.isError).toBeFalsy();

    const status = await toolset.executeTool({ id: '2', name: 'git_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(status.content.toLowerCase()).toContain('##');
  });

  it('returns an error outside git repositories', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const status = await toolset.executeTool({ id: '2', name: 'git_status', arguments: {} });
    expect(status.isError).toBe(true);
  });
});

describe('run_command safety', () => {
  it('blocks destructive commands', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command',
      arguments: { command: 'git reset --hard' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Blocked potentially destructive command');
  });

  it('honors run command allowlist prefixes', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      permissions: { runCommandAllowPrefixes: ['pnpm test'] },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command',
      arguments: { command: 'git status' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Blocked command outside allowlist');
  });
});