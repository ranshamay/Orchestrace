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
      'mode_get',
      'mode_set',
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
      'mode_get',
      'mode_set',
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
      'mode_get',
      'mode_set',
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

describe('mode tools smoke test', () => {
  it('mode_get returns the active mode and available modes', async () => {
    const cwd = await makeWorkspace();
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const result = await toolset.executeTool({ id: '1', name: 'mode_get', arguments: {} });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as { mode: string; availableModes: string[] };
    expect(parsed.mode).toBe('planning');
    expect(parsed.availableModes).toEqual(['chat', 'planning', 'implementation']);
  });

  it('mode_set transitions planning -> implementation and reports changed', async () => {
    const cwd = await makeWorkspace();
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'mode_set',
      arguments: { mode: 'implementation' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ mode: 'implementation', changed: true });
  });

  it('mode_set to the same mode reports unchanged', async () => {
    const cwd = await makeWorkspace();
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'mode_set',
      arguments: { mode: 'planning' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ mode: 'planning', changed: false });
  });

  it('mode_set returns an error for invalid mode input', async () => {
    const cwd = await makeWorkspace();
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'mode_set',
      arguments: { mode: 'invalid' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Missing mode. Expected one of: chat, planning, implementation.');
  });

  it('run_command is blocked in planning mode, then unblocked by mode_set', async () => {
    const cwd = await makeWorkspace();
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const blocked = await toolset.executeTool({
      id: '1',
      name: 'run_command',
      arguments: { command: 'echo hello' },
    });

    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('Tool run_command is not allowed while mode is planning');
    expect(blocked.content).toContain('Use mode_set to switch modes first');

    const switchResult = await toolset.executeTool({
      id: '2',
      name: 'mode_set',
      arguments: { mode: 'implementation' },
    });
    expect(switchResult.isError).toBeFalsy();
    expect(switchResult.details).toMatchObject({ mode: 'implementation', changed: true });

    const afterSwitch = await toolset.executeTool({
      id: '3',
      name: 'run_command',
      arguments: { command: 'echo hello' },
    });

    expect(afterSwitch.content).not.toContain('Tool run_command is not allowed while mode is planning');
  });
});

describe('subagent prompt enrichment', () => {
  it('auto-includes referenced file snippets for batch delegation', async () => {
    const cwd = await makeWorkspace();
    const delegatedPrompts: string[] = [];

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't1',
      runSubAgent: async (request) => {
        delegatedPrompts.push(request.prompt);
        return { text: 'ok' };
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          {
            nodeId: 'n1',
            prompt: 'Analyze src/file.ts and summarize its exported symbols.',
          },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(delegatedPrompts).toHaveLength(1);
    expect(delegatedPrompts[0]).toContain('[Auto-included file snippets]');
    expect(delegatedPrompts[0]).toContain('File: src/file.ts');
    expect(delegatedPrompts[0]).toContain('export const value = 1;');
  });
});