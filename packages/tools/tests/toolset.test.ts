import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      'agent_graph_get',
      'agent_graph_set',
      'git_diff',
      'git_status',
      'list_directory',
      'read_file',
      'read_files',
      'search_files',
      'subagent_list',
      'todo_add',
      'todo_get',
      'todo_set',
      'todo_update',
    ]);
  });

  it('exposes read-only required tools for chat', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'chat', taskType: 'code' });

    expect(toolNames(toolset)).toEqual([
      'agent_graph_get',
      'agent_graph_set',
      'git_diff',
      'git_status',
      'list_directory',
      'read_file',
      'read_files',
      'search_files',
      'subagent_list',
      'todo_add',
      'todo_get',
      'todo_set',
      'todo_update',
    ]);
  });

  it('exposes implementation tools including git_status and run_command', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    expect(toolNames(toolset)).toEqual([
      'agent_graph_get',
      'agent_graph_set',
      'edit_file',
      'edit_files',
      'git_diff',
      'git_status',
      'list_directory',
      'read_file',
      'read_files',
      'run_command',
      'run_command_batch',
      'search_files',
      'subagent_list',
      'todo_add',
      'todo_get',
      'todo_set',
      'todo_update',
      'write_file',
      'write_files',
    ]);
  });
});

describe('batch filesystem tools', () => {
  it('read_files returns results per file and reports missing files as failures', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'second.ts'), 'export const second = 2;\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/file.ts' },
          { path: 'src/second.ts' },
          { path: 'src/missing.ts' },
        ],
        concurrency: 3,
      },
    });

    expect(result.isError).toBe(true);

    const parsed = JSON.parse(result.content) as {
      total: number;
      successes: number;
      failures: number;
      files: Array<{ path: string; ok: boolean; content?: string; error?: string }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.successes).toBe(2);
    expect(parsed.failures).toBe(1);
    expect(parsed.files[0]).toMatchObject({ path: 'src/file.ts', ok: true });
    expect(parsed.files[1]).toMatchObject({ path: 'src/second.ts', ok: true });
    expect(parsed.files[2]).toMatchObject({ path: 'src/missing.ts', ok: false });
    expect(parsed.files[2].error).toBeDefined();
  });

  it('write_files writes multiple files and rejects duplicate paths', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const writeResult = await toolset.executeTool({
      id: '1',
      name: 'write_files',
      arguments: {
        files: [
          { path: 'src/a.ts', content: 'export const a = 1;\n' },
          { path: 'src/b.ts', content: 'export const b = 2;\n' },
        ],
        concurrency: 2,
      },
    });

    expect(writeResult.isError).toBeFalsy();

    const readResult = await toolset.executeTool({
      id: '2',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/a.ts' },
          { path: 'src/b.ts' },
        ],
      },
    });

    expect(readResult.isError).toBeFalsy();
    const parsedReads = JSON.parse(readResult.content) as {
      files: Array<{ path: string; ok: boolean; content?: string }>;
    };
    expect(parsedReads.files[0]).toMatchObject({ path: 'src/a.ts', ok: true });
    expect(parsedReads.files[1]).toMatchObject({ path: 'src/b.ts', ok: true });
    expect(parsedReads.files[0].content).toContain('export const a = 1;');
    expect(parsedReads.files[1].content).toContain('export const b = 2;');

    const duplicateResult = await toolset.executeTool({
      id: '3',
      name: 'write_files',
      arguments: {
        files: [
          { path: 'src/dup.ts', content: 'one' },
          { path: 'src/dup.ts', content: 'two' },
        ],
      },
    });

    expect(duplicateResult.isError).toBe(true);
    expect(duplicateResult.content).toContain('Duplicate paths are not allowed');
  });

  it('edit_files applies replacements in parallel and reports partial failures', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const seed = await toolset.executeTool({
      id: '1',
      name: 'write_files',
      arguments: {
        files: [
          { path: 'src/one.ts', content: 'export const value = 1;\n' },
          { path: 'src/two.ts', content: 'export const value = 1;\n' },
        ],
      },
    });
    expect(seed.isError).toBeFalsy();

    const editResult = await toolset.executeTool({
      id: '2',
      name: 'edit_files',
      arguments: {
        files: [
          { path: 'src/one.ts', oldText: 'value = 1', newText: 'value = 11', replaceAll: false },
          { path: 'src/two.ts', oldText: 'missing token', newText: 'value = 22', replaceAll: true },
        ],
        concurrency: 4,
      },
    });

    expect(editResult.isError).toBe(true);
    const parsedEdit = JSON.parse(editResult.content) as {
      total: number;
      successes: number;
      failures: number;
      files: Array<{ path: string; ok: boolean; replacements?: number; error?: string }>;
    };
    expect(parsedEdit.total).toBe(2);
    expect(parsedEdit.successes).toBe(1);
    expect(parsedEdit.failures).toBe(1);
    expect(parsedEdit.files[0]).toMatchObject({ path: 'src/one.ts', ok: true, replacements: 1 });
    expect(parsedEdit.files[1]).toMatchObject({ path: 'src/two.ts', ok: false });

    const verify = await toolset.executeTool({
      id: '3',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/one.ts' },
          { path: 'src/two.ts' },
        ],
      },
    });

    expect(verify.isError).toBeFalsy();
    const parsedVerify = JSON.parse(verify.content) as {
      files: Array<{ path: string; ok: boolean; content?: string }>;
    };
    expect(parsedVerify.files[0].content).toContain('value = 11');
    expect(parsedVerify.files[1].content).toContain('value = 1');
  });

  it('read_files supports adaptive concurrency metadata', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/file.ts' },
          { path: 'src/file.ts' },
        ],
        concurrency: 2,
        adaptiveConcurrency: true,
        minConcurrency: 1,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as {
      adaptiveConcurrency: boolean;
      minConcurrency: number;
      finalConcurrency: number;
      windows: number;
    };
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.minConcurrency).toBe(1);
    expect(parsed.finalConcurrency).toBeGreaterThanOrEqual(1);
    expect(parsed.windows).toBeGreaterThanOrEqual(1);
  });

  it('read_files uses run-level adaptive defaults when tool args omit them', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      adaptiveConcurrency: true,
      batchConcurrency: 2,
      batchMinConcurrency: 1,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/file.ts' },
          { path: 'src/file.ts' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as {
      adaptiveConcurrency: boolean;
      concurrency: number;
      minConcurrency: number;
    };
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.minConcurrency).toBe(1);
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

  it('runs command batches in parallel and reports blocked items', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command_batch',
      arguments: {
        commands: [
          { command: 'echo first' },
          { command: 'echo second' },
          { command: 'git reset --hard' },
        ],
        concurrency: 3,
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      total: number;
      completed: number;
      failed: number;
      commands: Array<{ command: string; ok: boolean; blocked: boolean; output: string }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.completed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.commands[0]).toMatchObject({ command: 'echo first', ok: true, blocked: false });
    expect(parsed.commands[1]).toMatchObject({ command: 'echo second', ok: true, blocked: false });
    expect(parsed.commands[2]).toMatchObject({ command: 'git reset --hard', ok: false, blocked: true });
    expect(parsed.commands[2].output).toContain('Blocked potentially destructive command');
  });

  it('run_command_batch supports adaptive concurrency metadata', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command_batch',
      arguments: {
        commands: [
          { command: 'echo first' },
          { command: 'echo second' },
          { command: 'git reset --hard' },
        ],
        concurrency: 4,
        adaptiveConcurrency: true,
        minConcurrency: 1,
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      adaptiveConcurrency: boolean;
      minConcurrency: number;
      finalConcurrency: number;
      windows: number;
      failed: number;
    };
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.minConcurrency).toBe(1);
    expect(parsed.failed).toBeGreaterThan(0);
    expect(parsed.finalConcurrency).toBeGreaterThanOrEqual(1);
    expect(parsed.windows).toBeGreaterThanOrEqual(1);
  });

  it('run_command_batch uses run-level adaptive defaults when tool args omit them', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      adaptiveConcurrency: true,
      batchConcurrency: 2,
      batchMinConcurrency: 1,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command_batch',
      arguments: {
        commands: [
          { command: 'echo first' },
          { command: 'echo second' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as {
      adaptiveConcurrency: boolean;
      concurrency: number;
      minConcurrency: number;
    };
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.minConcurrency).toBe(1);
  });
});

describe('github_api tool', () => {
  it('is hidden when no GitHub token resolver is configured', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    expect(toolNames(toolset)).not.toContain('github_api');
  });

  it('executes REST calls with authenticated headers', async () => {
    const cwd = await makeWorkspace();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ login: 'demo-user' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '4999',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'implementation',
        taskType: 'code',
        resolveGithubToken: async () => 'ghp_test_token',
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'github_api',
        arguments: { path: '/user' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('demo-user');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestUrl).toBe('https://api.github.com/user');
      expect(requestInit.headers).toMatchObject({
        Authorization: 'token ghp_test_token',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('subagent_spawn_batch supports adaptive concurrency metadata', async () => {
    const cwd = await makeWorkspace();

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't1',
      runSubAgent: async (request) => {
        if (request.nodeId === 'n2') {
          throw new Error('simulated failure');
        }

        return { text: `ok:${request.nodeId ?? 'none'}` };
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'n1', prompt: 'Inspect src/file.ts' },
          { nodeId: 'n2', prompt: 'Inspect src/file.ts' },
          { nodeId: 'n3', prompt: 'Inspect src/file.ts' },
        ],
        concurrency: 4,
        adaptiveConcurrency: true,
        minConcurrency: 1,
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      total: number;
      adaptiveConcurrency: boolean;
      minConcurrency: number;
      finalConcurrency: number;
      windows: number;
      failed: number;
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed' }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.minConcurrency).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.finalConcurrency).toBeGreaterThanOrEqual(1);
    expect(parsed.windows).toBeGreaterThanOrEqual(1);
    expect(parsed.runs.some((entry) => entry.nodeId === 'n2' && entry.status === 'failed')).toBe(true);
  });
});