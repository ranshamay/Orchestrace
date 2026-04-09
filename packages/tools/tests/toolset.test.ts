import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentToolset } from '../src/index.js';
import * as commandRunner from '../src/command-tools/command-runner.js';


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
      'todo_replan',
      'todo_set',
      'todo_update',

      'url_fetch',
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
      'todo_replan',
      'todo_set',
      'todo_update',

      'url_fetch',
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
      'playwright_run',
      'read_file',
      'read_files',
      'run_command',
      'run_command_batch',
      'search_files',
      'subagent_list',
            'todo_add',
      'todo_get',
      'todo_replan',
      'todo_set',
      'todo_update',

      'url_fetch',
      'write_file',
      'write_files',
    ]);
  });
});

describe('batch filesystem tools', () => {
  it('read_files reports required missing files as failures', async () => {
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
      optionalMissing: number;
      files: Array<{
        path: string;
        ok: boolean;
        required: boolean;
        status: 'ok' | 'optional_missing' | 'required_missing' | 'read_error';
        content?: string;
        error?: string;
      }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.successes).toBe(2);
    expect(parsed.failures).toBe(1);
    expect(parsed.optionalMissing).toBe(0);
    expect(parsed.files[0]).toMatchObject({ path: 'src/file.ts', ok: true, status: 'ok', required: true });
    expect(parsed.files[1]).toMatchObject({ path: 'src/second.ts', ok: true, status: 'ok', required: true });
    expect(parsed.files[2]).toMatchObject({ path: 'src/missing.ts', ok: false, status: 'required_missing', required: true });
    expect(parsed.files[2].error).toBeDefined();
  });

  it('read_files reports optional missing files without escalating tool error', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'second.ts'), 'export const second = 2;\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: 'optional-missing',
      name: 'read_files',
      arguments: {
        files: [
          { path: 'src/file.ts' },
          { path: 'src/second.ts' },
          { path: 'src/missing.ts', required: false },
        ],
        concurrency: 3,
      },
    });

    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content) as {
      total: number;
      successes: number;
      failures: number;
      optionalMissing: number;
      files: Array<{
        path: string;
        ok: boolean;
        required: boolean;
        status: 'ok' | 'optional_missing' | 'required_missing' | 'read_error';
        content?: string;
        error?: string;
      }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.successes).toBe(2);
    expect(parsed.failures).toBe(0);
    expect(parsed.optionalMissing).toBe(1);
    expect(parsed.files[0]).toMatchObject({ path: 'src/file.ts', ok: true, status: 'ok', required: true });
    expect(parsed.files[1]).toMatchObject({ path: 'src/second.ts', ok: true, status: 'ok', required: true });
    expect(parsed.files[2]).toMatchObject({ path: 'src/missing.ts', ok: false, status: 'optional_missing', required: false });
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

  it('edit_file rejects newline-only newText and does not mutate file', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const failedEdit = await toolset.executeTool({
      id: '1',
      name: 'edit_file',
      arguments: {
        path: 'src/file.ts',
        oldText: 'value = 1',
        newText: '\n',
      },
    });

    expect(failedEdit.isError).toBe(true);
    expect(failedEdit.content).toContain('Missing newText');

    const readBack = await toolset.executeTool({
      id: '2',
      name: 'read_file',
      arguments: { path: 'src/file.ts' },
    });

    expect(readBack.isError).toBeFalsy();
    expect(readBack.content).toContain('export const value = 1;');
  });

  it('edit_file rejects no-op replacement and does not mutate file', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const failedEdit = await toolset.executeTool({
      id: '1',
      name: 'edit_file',
      arguments: {
        path: 'src/file.ts',
        oldText: 'value = 1',
        newText: 'value = 1',
      },
    });

    expect(failedEdit.isError).toBe(true);
    expect(failedEdit.content).toContain('No-op edit is not allowed');

    const readBack = await toolset.executeTool({
      id: '2',
      name: 'read_file',
      arguments: { path: 'src/file.ts' },
    });

    expect(readBack.isError).toBeFalsy();
    expect(readBack.content).toContain('export const value = 1;');
  });

  it('edit_files rejects invalid replacement payloads before writing', async () => {
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

    const invalidBatch = await toolset.executeTool({
      id: '2',
      name: 'edit_files',
      arguments: {
        files: [
          { path: 'src/one.ts', oldText: 'value = 1', newText: '\n', replaceAll: false },
          { path: 'src/two.ts', oldText: 'value = 1', newText: 'value = 1', replaceAll: true },
        ],
      },
    });

    expect(invalidBatch.isError).toBe(true);
    expect(invalidBatch.content).toMatch(/Missing files\[0\]\.newText|No-op edit is not allowed/);

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
    expect(parsedVerify.files[0].content).toContain('value = 1');
    expect(parsedVerify.files[1].content).toContain('value = 1');
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

    it('read_file returns correct line slices for large files without full-read truncation artifacts', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const lines = Array.from({ length: 30_000 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(cwd, 'src', 'large.txt'), `${lines.join('\n')}\n`, 'utf-8');

    const result = await toolset.executeTool({
      id: '1',
      name: 'read_file',
      arguments: {
        path: 'src/large.txt',
        startLine: 20_000,
        endLine: 20_003,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('line-20000\nline-20001\nline-20002\nline-20003');
  });

  it('read_file applies deterministic maxChars truncation marker on large file reads', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const lines = Array.from({ length: 30_000 }, (_, index) => `entry-${index + 1}`);
    await writeFile(join(cwd, 'src', 'large-truncate.txt'), `${lines.join('\n')}\n`, 'utf-8');

    const result = await toolset.executeTool({
      id: '1',
      name: 'read_file',
      arguments: {
        path: 'src/large-truncate.txt',
        maxChars: 250,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content.endsWith('\n... (truncated)')).toBe(true);
    expect(result.content.length).toBe(250 + '\n... (truncated)'.length);
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

  it('invalidates cached read slices after write_file mutation', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const firstRead = await toolset.executeTool({
      id: '1',
      name: 'read_file',
      arguments: { path: 'src/file.ts' },
    });
    expect(firstRead.isError).toBeFalsy();
    expect(firstRead.content).toContain('value = 1');

    const writeResult = await toolset.executeTool({
      id: '2',
      name: 'write_file',
      arguments: { path: 'src/file.ts', content: 'export const value = 99;\n' },
    });
    expect(writeResult.isError).toBeFalsy();

    const secondRead = await toolset.executeTool({
      id: '3',
      name: 'read_file',
      arguments: { path: 'src/file.ts' },
    });
    expect(secondRead.isError).toBeFalsy();
    expect(secondRead.content).toContain('value = 99');
  });
});

describe('search_files tool', () => {
  it('treats query as literal by default and matches regex-special characters', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'literal.txt'), 'call(value)\ncallXvalue\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'call(value)',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('literal.txt:1:call(value)');
    expect(result.content).not.toContain('literal.txt:2:callXvalue');
  });

  it('supports regex mode when regex=true', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'regex.txt'), 'call(value)\ncallvalue\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'call(value)',
        regex: true,
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('regex.txt:2:callvalue');
    expect(result.content).not.toContain('regex.txt:1:call(value)');
  });

    it('returns (no matches) when nothing matches', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'definitely-not-present',
        path: 'src',
      },
    });

        expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(no matches)');
    expect(result.details).toBeUndefined();

  });

    it('keeps successful match payload non-error when ripgrep returns non-zero with stdout matches', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'match.ts'), 'validateShellCommandPrompt();\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockResolvedValueOnce({
      exitCode: 2,
      stdout: 'src/match.ts:1:validateShellCommandPrompt();\n',
      stderr: 'rg warning: simulated warning without blocking matches',
    });

    const result = await toolset.executeTool({
      id: 'non-zero-with-matches',
      name: 'search_files',
      arguments: {
        query: 'validateShellCommandPrompt',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src/match.ts:1:validateShellCommandPrompt();');
    expect(result.content).toContain('stderr:\nrg warning: simulated warning without blocking matches');
    expect(result.details).toBeUndefined();

    runCommandSpy.mockRestore();
  });

  it('treats ENOENT-like stderr as non-fatal when stdout already contains valid matches', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'coordination-tools.ts'), 'async function mapWithAdaptiveConcurrency() {}\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockResolvedValueOnce({
      exitCode: 2,
      stdout: 'src/coordination-tools.ts:1:async function mapWithAdaptiveConcurrency() {}\n',
      stderr: 'rg: async function mapWithAdaptiveConcurrency: No such file or directory (os error 2)',
    });

    const result = await toolset.executeTool({
      id: 'enoent-with-matches',
      name: 'search_files',
      arguments: {
        query: 'async function mapWithAdaptiveConcurrency',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src/coordination-tools.ts:1:async function mapWithAdaptiveConcurrency() {}');
    expect(result.content).toContain('No such file or directory (os error 2)');
    expect(result.details).toBeUndefined();

    runCommandSpy.mockRestore();
  });


    it('marks search_files as error for genuine command failures without match output', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'rg: simulated command failure',
    });

    const result = await toolset.executeTool({
      id: 'non-zero-no-matches',
      name: 'search_files',
      arguments: {
        query: 'value',
        path: 'src',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('stderr:\nrg: simulated command failure');
    expect(result.details).toMatchObject({
      errorType: 'command_failed',
      toolName: 'search_files',
      exitCode: 2,
      command: 'rg',
      path: 'src',
    });

    runCommandSpy.mockRestore();
  });

    it('passes -- before pattern arguments so option-like queries stay as query text', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });
    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });

    const result = await toolset.executeTool({
      id: 'separator-before-pattern',
      name: 'search_files',
      arguments: {
        query: '-foo',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(runCommandSpy).toHaveBeenCalledOnce();

    const args = runCommandSpy.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--fixed-strings', '--', '-foo', 'src']));

    const separatorIndex = args.indexOf('--');
    const patternValueIndex = args.indexOf('-foo');
    const pathIndex = args.indexOf('src');

    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    expect(patternValueIndex).toBe(separatorIndex + 1);
    expect(pathIndex).toBe(patternValueIndex + 1);

    runCommandSpy.mockRestore();
  });


    it('treats regression tokens as query text, not file paths', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'tokens.txt'),
      'retry\nsubagent_spawn_batch\ngithub-copilot\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'subagent_spawn_batch',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('tokens.txt:2:subagent_spawn_batch');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

  it('handles observer-reported identifier queries as plain search terms', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'observer-identifiers.ts'),
      [
        'function checkTokenTTL() {}',
        'function ensureGithubCopilotTokenTTL() {}',
        'const copilot = true;',
        'subagent_spawn_batch([]);',
      ].join('\n') + '\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const queries = [
      'checkTokenTTL',
      'ensureGithubCopilotTokenTTL',
      'copilot',
      'subagent_spawn_batch',
    ];

    for (const query of queries) {
      const result = await toolset.executeTool({
        id: `observer-${query}`,
        name: 'search_files',
        arguments: {
          query,
          path: 'src',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(query);
      expect(result.content.toLowerCase()).not.toContain('no such file or directory');
      expect(result.content.toLowerCase()).not.toContain('os error 2');
    }
  });

  it('rejects multiline query payloads before invoking ripgrep', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: 'invalid-query-multiline',
      name: 'search_files',
      arguments: {
        query: 'copilot\ncheckTokenTTL',
        path: 'src',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid query: query must be a single-line string.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

  it('rejects query payloads that look like ripgrep path/filter fragments', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: 'invalid-query-fragment',
      name: 'search_files',
      arguments: {
        query: '--glob src/**/*.ts',
        path: 'src',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid query: query appears to be a ripgrep path/filter fragment. Provide search text in query and file scope in path/glob.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });


      it('treats colon tokens as plain query text', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'tokens-colon.txt'),
      'task:tool-call\nrunSubAgent\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'task:tool-call',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('tokens-colon.txt:1:task:tool-call');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

  it('treats shell-like query text such as sh -c as a literal search by default', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'shell-like.txt'),
      'sh -c\nshh -c\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'sh -c',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('shell-like.txt:1:sh -c');
    expect(result.content).not.toContain('shell-like.txt:2:shh -c');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

    it('honors explicit regex mode even for shell-like query text', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'shell-like-regex.txt'),
      'sh -c\nshh -c\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'sh+ -c',
        queryMode: 'regex',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('shell-like-regex.txt:1:sh -c');
    expect(result.content).toContain('shell-like-regex.txt:2:shh -c');
  });

    it('treats execFileAsync call snippets as plain literal query text by default', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'exec-snippet.ts'),
      "const cmd = execFileAsync('sh', ['-lc', 'echo hi']);\nconst x = 1;\n",
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: "execFileAsync('sh', ['-lc',",
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("exec-snippet.ts:1:const cmd = execFileAsync('sh', ['-lc', 'echo hi']);");
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
    expect(result.content.toLowerCase()).not.toContain('os error 2');
  });

  it('keeps repeated common-pattern searches on the same file non-error', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'observer-patterns.ts'),
      [
        "const cmd = execFileAsync('sh', ['-lc', 'echo hi']);",
        'subagent_spawn_batch(agentRequests);',
        'github-copilot',
      ].join('\n') + '\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const patterns = [
      "execFileAsync('sh', ['-lc',",
      'subagent_spawn_batch',
      'github-copilot',
    ];

    for (const pattern of patterns) {
      const result = await toolset.executeTool({
        id: `repeat-${pattern}`,
        name: 'search_files',
        arguments: {
          query: pattern,
          path: 'src/observer-patterns.ts',
        },
      });

            expect(result.isError).toBeFalsy();
      expect(result.content).toContain(pattern);
      expect(result.content.toLowerCase()).not.toContain('no such file or directory');
      expect(result.content.toLowerCase()).not.toContain('os error 2');
    }
  });


  it('treats unmatched punctuation-heavy function call fragments as literal search text', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'punctuation-fragments.ts'),
      "execFileAsync('sh', ['-lc',\n",
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: "execFileAsync('sh', ['-lc'",
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("punctuation-fragments.ts:1:execFileAsync('sh', ['-lc',");
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
    expect(result.content.toLowerCase()).not.toContain('os error 2');
  });

  it('still supports explicit regex semantics for function-call-like snippets', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'exec-regex.ts'),
      "execFileAsync('sh', ['-lc', 'one']);\nexecFileAsync('shh', ['-lc', 'two']);\n",
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: "execFileAsync\\('sh+',",
        queryMode: 'regex',
        path: 'src',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("exec-regex.ts:1:execFileAsync('sh', ['-lc', 'one']);");
    expect(result.content).toContain("exec-regex.ts:2:execFileAsync('shh', ['-lc', 'two']);");
  });

  it('skips invalid target paths without surfacing retriable ripgrep errors', async () => {

    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'value',
        path: 'src/missing-directory',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(skipped invalid search path: src/missing-directory)');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

    it('returns a clear validation error for empty query text', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: '   ',
        path: 'src',
      },
    });

        expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid query: query must not be empty.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      message: 'Invalid query: query must not be empty.',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');

  });

  it('returns a clear validation error for control characters in query text', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: `copilot${String.fromCharCode(1)}token`,
        path: 'src',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid query: control characters are not allowed.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      message: 'Invalid query: control characters are not allowed.',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });


        it('returns a clear invalid_regex error for malformed explicit regex input', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'routes.ts'),
      'runShellCommandRoute(\nrunShellCommandRoute\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'runShellCommandRoute(',
        queryMode: 'regex',
        path: 'src',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid regex query.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_regex',
      message: 'Invalid regex query.',
      toolName: 'search_files',
      path: 'src',
    });
  });


  it('returns a clear validation error for malformed regex that cannot be repaired', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: '(?z)invalid',
        queryMode: 'regex',
        path: 'src',
      },
    });

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Invalid regex query.');
      expect(result.details).toMatchObject({
        errorType: 'invalid_regex',
        message: 'Invalid regex query.',
        toolName: 'search_files',
        path: 'src',
      });
      expect(result.content.toLowerCase()).not.toContain('regex parse error');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');

  });


  it('returns a clear validation error for empty glob text', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'value',
        path: 'src',
        glob: '   ',
      },
    });

        expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid glob: expected a non-empty string when provided.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      message: 'Invalid glob: expected a non-empty string when provided.',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');

  });

    it('returns a clear validation error when glob is used with a file path', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'file-only.txt'), 'value\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'value',
        path: 'src/file-only.txt',
        glob: '*.txt',
      },
    });

        expect(result.isError).toBe(true);
    expect(result.content).toBe('Invalid glob usage: glob can only be used when path points to a directory.');
    expect(result.details).toMatchObject({
      errorType: 'invalid_arguments',
      message: 'Invalid glob usage: glob can only be used when path points to a directory.',
      toolName: 'search_files',
      path: 'src/file-only.txt',
    });
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');

  });

  it('returns a deterministic error when cwd is invalid', async () => {
    const cwd = await makeWorkspace();
    const invalidCwd = join(cwd, 'definitely-missing-cwd');
    const toolset = createAgentToolset({ cwd: invalidCwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'value',
        path: 'src',
      },
    });

        expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid working directory for search_files:');
    expect(result.details).toMatchObject({
      errorType: 'invalid_working_directory',
      toolName: 'search_files',
      path: 'src',
    });
    expect(result.content.toLowerCase()).not.toContain('ripgrep');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');

  });

    it('accepts absolute search path inside workspace and returns normalized matches', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'coordination.ts'), 'interface CoordinationState { ok: true }\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'interface CoordinationState',
        path: join(cwd, 'src'),
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src/coordination.ts:1:interface CoordinationState { ok: true }');
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
  });

  it('finds runner.ts identifiers without surfacing no-such-file noise', async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, 'src', 'runner.ts'),
      [
        'function extractShellCommand() {}',
        'function resolveTaskRoute() {}',
        'function runShellCommandRoute() {}',
      ].join('\n') + '\n',
      'utf-8',
    );
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'extractShellCommand',
        path: 'src/runner.ts',
      },
    });

        expect(result.isError).toBeFalsy();
    expect(result.content).toContain('1:function extractShellCommand() {}');
    expect(result.details).toBeUndefined();
    expect(result.content.toLowerCase()).not.toContain('no such file or directory');
    expect(result.content.toLowerCase()).not.toContain('os error 2');
  });

    it('keeps missing TypeScript file path handling deterministic and skips ripgrep execution', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });
    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand');

    const result = await toolset.executeTool({
      id: '1',
      name: 'search_files',
      arguments: {
        query: 'StartWorkSession',
        path: 'packages/cli/src/ui-server.ts',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(skipped invalid search path: packages/cli/src/ui-server.ts)');
    expect(result.details).toBeUndefined();
    expect(runCommandSpy).not.toHaveBeenCalled();

    runCommandSpy.mockRestore();
  });
});

describe('git_status and git_diff session gating', () => {
  it('returns status output in a git repository when task requires writes', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      taskRequiresWrites: true,
    });

    const init = await toolset.executeTool({ id: '1', name: 'run_command', arguments: { command: 'git init' } });
    expect(init.isError).toBeFalsy();

                const status = await toolset.executeTool({
      id: '2',
      name: 'git_status',
      arguments: { intent: 'write' },
    });
    expect(status.isError).toBeFalsy();
    expect(status.content.toLowerCase()).toContain('##');
  });

  it('returns an error outside git repositories when task requires writes', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      taskRequiresWrites: true,
    });

        const status = await toolset.executeTool({
      id: '2',
      name: 'git_status',
      arguments: { intent: 'write' },
    });
    expect(status.isError).toBe(true);
  });

  it('rejects git_status calls for read-only task sessions', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      taskRequiresWrites: false,
    });

    const status = await toolset.executeTool({ id: '1', name: 'git_status', arguments: {} });
    expect(status.isError).toBe(true);
    expect(status.content).toBe('Task classified as read-only during planning; git_status is not needed.');
  });

  it('rejects git_diff calls for read-only task sessions', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      taskRequiresWrites: false,
    });

        const diff = await toolset.executeTool({
      id: '1',
      name: 'git_diff',
      arguments: {},
    });
    expect(diff.isError).toBe(true);
    expect(diff.content).toBe('Task classified as read-only during planning; git_diff is not needed.');
  });

  it('accepts git_diff calls when task requires writes', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({
      cwd,
      phase: 'implementation',
      taskType: 'code',
      taskRequiresWrites: true,
    });

    const init = await toolset.executeTool({ id: '1', name: 'run_command', arguments: { command: 'git init' } });
    expect(init.isError).toBeFalsy();

        const diff = await toolset.executeTool({
      id: '2',
      name: 'git_diff',
      arguments: { intent: 'write' },
    });
    expect(diff.isError).toBeFalsy();
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

  it('rejects markdown-like single-line payloads before shell execution', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command',
      arguments: { command: '## Task: run git status' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Blocked non-command payload');
    expect(result.content).toContain('markdown/instructional');
  });

  it('rejects multiline observer-style payloads before shell execution', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    const result = await toolset.executeTool({
      id: '1',
      name: 'run_command',
      arguments: {
        command: [
          '[Observer Fix] Task prompt passed directly as shell command',
          '',
          'Category: architecture | Severity: critical',
          '',
          '## Task',
          'Route to coding agent prompt field.',
        ].join('\n'),
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Blocked non-command payload');
    expect(result.content).toContain('multiple lines');
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
          { command: '## Task: run git status' },
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

    expect(parsed.total).toBe(4);
    expect(parsed.completed).toBe(2);
    expect(parsed.failed).toBe(2);
    expect(parsed.commands[0]).toMatchObject({ command: 'echo first', ok: true, blocked: false });
    expect(parsed.commands[1]).toMatchObject({ command: 'echo second', ok: true, blocked: false });
    expect(parsed.commands[2]).toMatchObject({ command: 'git reset --hard', ok: false, blocked: true });
    expect(parsed.commands[2].output).toContain('Blocked potentially destructive command');
    expect(parsed.commands[3]).toMatchObject({ command: '## Task: run git status', ok: false, blocked: true });
    expect(parsed.commands[3].output).toContain('Blocked non-command payload');
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

describe('url_fetch tool', () => {
  it('is available in planning and implementation phases', async () => {
    const cwd = await makeWorkspace();
    const planningToolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });
    const implementationToolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });

    expect(toolNames(planningToolset)).toContain('url_fetch');
    expect(toolNames(implementationToolset)).toContain('url_fetch');
  });

  it('fetches JSON response and returns parsed data', async () => {
    const cwd = await makeWorkspace();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, name: 'demo' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const toolset = createAgentToolset({ cwd, phase: 'implementation', taskType: 'code' });
      const result = await toolset.executeTool({
        id: '1',
        name: 'url_fetch',
        arguments: { url: 'https://example.com/data' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('"name": "demo"');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestUrl).toBe('https://example.com/data');
      expect(requestInit.method).toBe('GET');
    } finally {
      vi.unstubAllGlobals();
    }
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
                resolveGithubToken: async (_options) => 'ghp_test_token',

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

describe('coordination plan lock and replan controls', () => {
  it('normalizes missing plan lock fields and exposes default state behavior', async () => {
    const cwd = await makeWorkspace();
    const graphId = 'g-normalize';
    const taskId = 't-normalize';
    const stateDir = join(cwd, '.orchestrace', 'coordination', graphId, taskId);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'state.json'),
      JSON.stringify({
        updatedAt: '2020-01-01T00:00:00.000Z',
        todos: [{ id: 'a', title: 'A', status: 'todo' }],
        agentGraph: { nodes: [] },
        subAgents: [],
      }, null, 2),
      'utf-8',
    );

    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code', graphId, taskId });

    const replan = await toolset.executeTool({
      id: '1',
      name: 'todo_replan',
      arguments: {
        items: [{ id: 'b', title: 'B', status: 'todo' }],
      },
    });

    expect(replan.isError).toBeFalsy();
    expect(replan.content).toContain('Replan count is now 1/3');
  });

  it('rejects todo_set and agent_graph_set when plan is locked', async () => {
    const cwd = await makeWorkspace();
    const graphId = 'g-locked';
    const taskId = 't-locked';
    const stateDir = join(cwd, '.orchestrace', 'coordination', graphId, taskId);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'state.json'),
      JSON.stringify({
        updatedAt: '2020-01-01T00:00:00.000Z',
        todos: [],
        agentGraph: { nodes: [] },
        subAgents: [],
        planLocked: true,
        replanCount: 0,
      }, null, 2),
      'utf-8',
    );

    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code', graphId, taskId });

    const todoSet = await toolset.executeTool({
      id: '1',
      name: 'todo_set',
      arguments: {
        items: [{ id: 'x', title: 'X', status: 'todo' }],
      },
    });
    expect(todoSet.isError).toBe(true);
    expect(todoSet.content).toContain('Cannot run todo_set: plan is locked (planLocked=true).');

    const graphSet = await toolset.executeTool({
      id: '2',
      name: 'agent_graph_set',
      arguments: {
        nodes: [{ id: 'n1', prompt: 'Do the thing' }],
      },
    });
    expect(graphSet.isError).toBe(true);
    expect(graphSet.content).toContain('Cannot run agent_graph_set: plan is locked (planLocked=true).');
  });

  it('increments replan count on success and enforces cap with clear error', async () => {
    const cwd = await makeWorkspace();
    const graphId = 'g-replan-cap';
    const taskId = 't-replan-cap';
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code', graphId, taskId });

    for (let index = 1; index <= 3; index += 1) {
      const result = await toolset.executeTool({
        id: `ok-${index}`,
        name: 'todo_replan',
        arguments: {
          items: [{ id: `todo-${index}`, title: `Todo ${index}`, status: 'todo' }],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(`Replan count is now ${index}/3`);
    }

    const capped = await toolset.executeTool({
      id: 'capped',
      name: 'todo_replan',
      arguments: {
        items: [{ id: 'todo-4', title: 'Todo 4', status: 'todo' }],
      },
    });

    expect(capped.isError).toBe(true);
    expect(capped.content).toContain('Cannot run todo_replan: replan limit reached (current=3, max=3).');
  });

  it('locks plan when mode_set switches to implementation, then blocks replanning', async () => {
    const cwd = await makeWorkspace();
    const graphId = 'g-mode-lock';
    const taskId = 't-mode-lock';
    let mode: 'planning' | 'implementation' | 'chat' = 'planning';

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId,
      taskId,
      modeController: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          const changed = mode !== nextMode;
          mode = nextMode;
          return { mode, changed };
        },
      },
    });

    const switchResult = await toolset.executeTool({
      id: '1',
      name: 'mode_set',
      arguments: { mode: 'implementation' },
    });
    expect(switchResult.isError).toBeFalsy();

    const blocked = await toolset.executeTool({
      id: '2',
      name: 'todo_set',
      arguments: {
        items: [{ id: 'x', title: 'X', status: 'todo' }],
      },
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('Cannot run todo_set: plan is locked (planLocked=true).');
  });
});

describe('subagent prompt enrichment', () => {

  it('subagent_spawn validates args synchronously and skips sub-agent invocation on malformed payload', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: 't-sync-validation-single',
        runSubAgent,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn',
        arguments: {
          contextPacket: {
            objective: 'Investigate failing task',
            boundaries: {
              timeoutMs: 0,
            },
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent_spawn argument validation failed before spawn');
      expect(result.content).toContain('contextPacket.boundaries.timeoutMs');
      expect(runSubAgent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

    it('subagent_spawn_batch validates args synchronously and skips all sub-agent invocations on malformed payload', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: 't-sync-validation-batch',
        runSubAgent,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [
            {
              contextPacket: {
                objective: 'Review code',
              },
              unexpected: true,
            },
          ],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent_spawn_batch argument validation failed before spawn');
      expect(result.content).toContain('agents.0');
      expect(result.content).toContain('additional properties');
      expect(runSubAgent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subagent_spawn_batch preflight fails fast for github-copilot when token TTL is insufficient', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));
    const resolveGithubToken = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: 't-preflight-ttl-fail',
        provider: 'github-copilot',
        runSubAgent,
        resolveGithubToken,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [{ nodeId: 'n1', prompt: 'Inspect src/file.ts for exports.' }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent_spawn_batch preflight failed');
      expect(result.content).toContain('provider=github-copilot');
      expect(result.content).toContain('Action required: refresh/re-auth GitHub Copilot credentials and retry.');
      expect(runSubAgent).not.toHaveBeenCalled();
      expect(resolveGithubToken).toHaveBeenCalledWith({ minimumTtlSeconds: 600 });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subagent_spawn_batch preflight fails gracefully when github-copilot token refresh throws', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));
    const resolveGithubToken = vi.fn(async () => {
      throw new Error('unauthorized: token expired');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: 't-preflight-throw-fail',
        runSubAgent,
        resolveGithubToken,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [{ nodeId: 'n1', provider: 'github-copilot', prompt: 'Inspect src/file.ts for exports.' }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent_spawn_batch preflight failed');
      expect(result.content).toContain('token refresh/reacquisition threw an error');
      expect(result.content).toContain('reason=unauthorized: token expired');
      expect(result.content).toContain('Action required: refresh/re-auth GitHub Copilot credentials and retry.');
      expect(runSubAgent).not.toHaveBeenCalled();
      expect(resolveGithubToken).toHaveBeenCalledWith({ minimumTtlSeconds: 600 });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subagent_spawn_batch preflight fails when github-copilot provider is requested but resolver is unavailable', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: 't-preflight-no-resolver',
        runSubAgent,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [{ nodeId: 'n1', provider: 'github-copilot', prompt: 'Inspect src/file.ts for exports.' }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent_spawn_batch preflight failed');
      expect(result.content).toContain('resolveGithubToken is not configured');
      expect(result.content).toContain('Action required: refresh/re-auth GitHub Copilot credentials and retry.');
      expect(runSubAgent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subagent_spawn_batch proceeds when github-copilot preflight token is healthy', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'ok' }));
    const resolveGithubToken = vi.fn(async () => 'ghp_valid_preflight_token');

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-preflight-healthy',
      provider: 'github-copilot',
      runSubAgent,
      resolveGithubToken,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'n1', prompt: 'Inspect src/file.ts for exports.' }],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(resolveGithubToken).toHaveBeenCalledWith({ minimumTtlSeconds: 600 });
    expect(runSubAgent).toHaveBeenCalledTimes(1);
  });

  it('prefers provided context packet snippets over disk reads', async () => {

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
      name: 'subagent_spawn',
      arguments: {
        contextPacket: {
          objective: 'Summarize src/file.ts',
          fileSnippets: [
            { path: 'src/file.ts', content: 'export const value = 777;\n' },
          ],
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(delegatedPrompts).toHaveLength(1);
    expect(delegatedPrompts[0]).toContain('[Auto-included file snippets]');
    expect(delegatedPrompts[0]).toContain('File: src/file.ts');
    expect(delegatedPrompts[0]).toContain('export const value = 777;');
    expect(delegatedPrompts[0]).not.toContain('export const value = 1;');
  });

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
            reasoning: 'high',
            contextPacket: {
              objective: 'Document exported symbols and include confidence notes.',
              relevantContext: ['Used for integration tests', 'Output consumed by CI summaries'],
              requiredOutputSchema: '{ symbols: string[], notes: string[] }',
              evidenceRequirements: ['Cite src/file.ts lines'],
              boundaries: { writePolicy: 'none' },
            },
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

        return {
          text: `ok:${request.nodeId ?? 'none'}`,
          usage: { input: 12, output: 6, cost: 0.012 },
        };
      },
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          {
            nodeId: 'n1',
            prompt: 'Inspect src/file.ts for exports and test impact.',
            reasoning: 'high',
            contextPacket: {
              objective: 'Produce test-impact notes.',
              relevantContext: ['Used by runtime entrypoint', 'Used by tests'],
              requiredOutputSchema: '{ findings: string[] }',
              evidenceRequirements: ['Cite file snippets'],
            },
          },
          {
            nodeId: 'n2',
            prompt: 'Inspect src/file.ts for exports and test impact.',
            reasoning: 'high',
            contextPacket: {
              objective: 'Produce test-impact notes.',
              relevantContext: ['Used by runtime entrypoint', 'Used by tests'],
              requiredOutputSchema: '{ findings: string[] }',
              evidenceRequirements: ['Cite file snippets'],
            },
          },
          {
            nodeId: 'n3',
            prompt: 'Inspect src/file.ts for exports and test impact.',
            reasoning: 'high',
            contextPacket: {
              objective: 'Produce test-impact notes.',
              relevantContext: ['Used by runtime entrypoint', 'Used by tests'],
              requiredOutputSchema: '{ findings: string[] }',
              evidenceRequirements: ['Cite file snippets'],
            },
          },
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
      usage: { input: number; output: number; cost: number };
      decomposition: {
        averagePromptChars: number;
        maxPromptChars: number;
        promptSoftLimitChars: number;
        oversizedTasks: string[];
      };
      runs: Array<{
        nodeId?: string;
        status: 'completed' | 'failed';
        promptChars: number;
        promptPreview: string;
        usage?: { input: number; output: number; cost: number };
      }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.adaptiveConcurrency).toBe(true);
    expect(parsed.minConcurrency).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.usage.input).toBe(24);
    expect(parsed.usage.output).toBe(12);
    expect(parsed.finalConcurrency).toBeGreaterThanOrEqual(1);
    expect(parsed.windows).toBeGreaterThanOrEqual(1);
    expect(parsed.decomposition.averagePromptChars).toBeGreaterThan(0);
    expect(parsed.decomposition.maxPromptChars).toBeGreaterThanOrEqual(parsed.decomposition.averagePromptChars);
    expect(parsed.decomposition.promptSoftLimitChars).toBeGreaterThan(0);
    expect(Array.isArray(parsed.decomposition.oversizedTasks)).toBe(true);
    expect(parsed.runs.every((entry) => entry.promptChars > 0)).toBe(true);
    expect(parsed.runs.some((entry) => entry.nodeId === 'n2' && entry.status === 'failed')).toBe(true);
    expect(parsed.runs.some((entry) => entry.nodeId === 'n1' && entry.status === 'completed' && entry.usage?.input === 12)).toBe(true);
  });

  it('subagent_spawn_batch retries only failed nodeIds and merges retried success', async () => {
    const cwd = await makeWorkspace();
    const callCount = new Map<string, number>();

    const runSubAgent = vi.fn(async (request: { nodeId?: string }) => {
      const nodeId = request.nodeId ?? 'none';
      const count = (callCount.get(nodeId) ?? 0) + 1;
      callCount.set(nodeId, count);

      if (nodeId === 'n2' && count === 1) {
        throw new Error('n2 fails on first attempt');
      }

      return {
        text: `ok:${nodeId}:attempt-${count}`,
        usage: { input: 10, output: 4, cost: 0.01 },
      };
    });

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-retry-partial',
      runSubAgent,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'n1', prompt: 'Inspect src/file.ts for n1' },
          { nodeId: 'n2', prompt: 'Inspect src/file.ts for n2' },
        ],
        maxRetries: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(runSubAgent).toHaveBeenCalledTimes(3);
    expect(callCount.get('n1')).toBe(1);
    expect(callCount.get('n2')).toBe(2);

    const parsed = JSON.parse(result.content) as {
      failed: number;
      completed: number;
      maxRetries: number;
      failedNodeIds: string[];
      dispatchedNodeIds: string[];
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed' }>;
    };

    expect(parsed.maxRetries).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.completed).toBe(2);
    expect(parsed.failedNodeIds).toEqual([]);
    expect(parsed.dispatchedNodeIds.filter((id) => id === 'n1')).toHaveLength(1);
    expect(parsed.dispatchedNodeIds.filter((id) => id === 'n2')).toHaveLength(2);
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[0]).toMatchObject({ nodeId: 'n1', status: 'completed' });
    expect(parsed.runs[1]).toMatchObject({ nodeId: 'n2', status: 'completed' });
  });

  it('subagent_spawn_batch defaults maxRetries when argument is non-finite or non-number', async () => {
    const invalidMaxRetries = [Number.NaN, Number.POSITIVE_INFINITY, '3'];

    for (const maxRetries of invalidMaxRetries) {
      const cwd = await makeWorkspace();
      const runSubAgent = vi.fn(async () => ({ text: 'ok', usage: { input: 1, output: 1, cost: 0.001 } }));

      const toolset = createAgentToolset({
        cwd,
        phase: 'planning',
        taskType: 'code',
        graphId: 'g1',
        taskId: `t-retry-default-${String(maxRetries)}`,
        runSubAgent,
      });

      const result = await toolset.executeTool({
        id: '1',
        name: 'subagent_spawn_batch',
        arguments: {
          agents: [{ nodeId: 'n1', prompt: 'Inspect src/file.ts.' }],
          maxRetries,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content) as { maxRetries: number };
      expect(parsed.maxRetries).toBe(2);
    }
  });

  it('subagent_spawn_batch honors maxRetries cap for persistent failures', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async (request: { nodeId?: string }) => {
      if (request.nodeId === 'n-fail') {
        throw new Error('always fails');
      }

      return { text: 'ok', usage: { input: 1, output: 1, cost: 0.001 } };
    });

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-retry-cap',
      runSubAgent,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'n-fail', prompt: 'Inspect src/file.ts and fail.' }],
        maxRetries: 2,
      },
    });

    expect(result.isError).toBe(true);
    expect(runSubAgent).toHaveBeenCalledTimes(3);

    const parsed = JSON.parse(result.content) as {
      maxRetries: number;
      completed: number;
      failed: number;
      failedNodeIds: string[];
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed' }>;
    };

    expect(parsed.maxRetries).toBe(2);
    expect(parsed.completed).toBe(0);
    expect(parsed.failed).toBe(1);
    expect(parsed.failedNodeIds).toEqual(['n-fail']);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({ nodeId: 'n-fail', status: 'failed' });
  });

  it('subagent_spawn_batch trips circuit breaker on third identical failure wave', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => {
      throw new Error('provider timeout');
    });

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-retry-breaker',
      runSubAgent,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'n-fail', prompt: 'Inspect src/file.ts and fail.' }],
        maxRetries: 5,
      },
    });

    expect(result.isError).toBe(true);
    expect(runSubAgent).toHaveBeenCalledTimes(3);

    const parsed = JSON.parse(result.content) as {
      status?: string;
      reason?: string;
      consecutiveIdenticalFailures?: number;
      failedNodeIds: string[];
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed'; error?: string }>;
    };

    expect(parsed.status).toBe('escalated_error');
    expect(parsed.reason).toBe('identical_subagent_batch_failures_repeated');
    expect(parsed.consecutiveIdenticalFailures).toBe(3);
    expect(parsed.failedNodeIds).toEqual(['n-fail']);
    expect(parsed.runs[0]?.error).toContain('Circuit breaker tripped');
  });

  it('subagent_spawn_batch does not trip breaker when failed node set changes', async () => {
    const cwd = await makeWorkspace();
    const callCount = new Map<string, number>();
    const runSubAgent = vi.fn(async (request: { nodeId?: string }) => {
      const nodeId = request.nodeId ?? 'none';
      const count = (callCount.get(nodeId) ?? 0) + 1;
      callCount.set(nodeId, count);

      if (nodeId === 'n1' && count === 1) {
        throw new Error('n1 first-wave failure');
      }
      if (nodeId === 'n2' && count === 1) {
        throw new Error('n2 second-wave failure');
      }

      return { text: 'ok', usage: { input: 1, output: 1, cost: 0.001 } };
    });

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-retry-changing',
      runSubAgent,
    });

    const result = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'n1', prompt: 'task n1' },
          { nodeId: 'n2', prompt: 'task n2' },
        ],
        maxRetries: 3,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as {
      status?: string;
      completed: number;
      failed: number;
    };

    expect(parsed.status).toBeUndefined();
    expect(parsed.completed).toBe(2);
    expect(parsed.failed).toBe(0);
  });

  it('subagent_spawn_batch reuses cached completed results when all nodeIds are cache hits', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async () => ({ text: 'unexpected dispatch' }));

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-cache-all-hit',
      runSubAgent,
    });

    const first = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'n1', prompt: 'Inspect src/file.ts for exports' },
          { nodeId: 'n2', prompt: 'Inspect src/file.ts for imports' },
        ],
      },
    });
    expect(first.isError).toBeFalsy();
    expect(runSubAgent).toHaveBeenCalledTimes(2);

    runSubAgent.mockClear();

    const second = await toolset.executeTool({
      id: '2',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'n1', prompt: 'Inspect src/file.ts for exports' },
          { nodeId: 'n2', prompt: 'Inspect src/file.ts for imports' },
        ],
      },
    });

    expect(second.isError).toBeFalsy();
    expect(runSubAgent).toHaveBeenCalledTimes(0);

    const parsed = JSON.parse(second.content) as {
      total: number;
      failed: number;
      cacheHitCount: number;
      cacheMissCount: number;
      cachedNodeIds: string[];
      dispatchedNodeIds: string[];
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed'; cacheHit?: boolean }>;
    };

    expect(parsed.total).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.cacheHitCount).toBe(2);
    expect(parsed.cacheMissCount).toBe(0);
    expect(parsed.cachedNodeIds).toEqual(['n1', 'n2']);
    expect(parsed.dispatchedNodeIds).toEqual([]);
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs.every((run) => run.status === 'completed')).toBe(true);
    expect(parsed.runs.every((run) => run.cacheHit === true)).toBe(true);
  });

  it('subagent_spawn_batch dispatches only cache misses in mixed cache-hit and miss batches', async () => {
    const cwd = await makeWorkspace();
    const runSubAgent = vi.fn(async (request: { nodeId?: string }) => ({
      text: `ok:${request.nodeId ?? 'none'}`,
      usage: { input: 5, output: 2, cost: 0.001 },
    }));

    const toolset = createAgentToolset({
      cwd,
      phase: 'planning',
      taskType: 'code',
      graphId: 'g1',
      taskId: 't-cache-mixed',
      runSubAgent,
    });

    const seed = await toolset.executeTool({
      id: '1',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [{ nodeId: 'cached-node', prompt: 'Seed cached node result from src/file.ts' }],
      },
    });
    expect(seed.isError).toBeFalsy();
    expect(runSubAgent).toHaveBeenCalledTimes(1);

    runSubAgent.mockClear();

    const mixed = await toolset.executeTool({
      id: '2',
      name: 'subagent_spawn_batch',
      arguments: {
        agents: [
          { nodeId: 'cached-node', prompt: 'Reuse cached node result from src/file.ts' },
          { nodeId: 'fresh-node', prompt: 'Need a fresh run for src/file.ts' },
          { prompt: 'No nodeId should always dispatch for src/file.ts' },
        ],
      },
    });

    expect(mixed.isError).toBeFalsy();
    expect(runSubAgent).toHaveBeenCalledTimes(2);
    expect(runSubAgent.mock.calls[0]?.[0]?.nodeId).toBe('fresh-node');
    expect(runSubAgent.mock.calls[1]?.[0]?.nodeId).toBeUndefined();

    const parsed = JSON.parse(mixed.content) as {
      total: number;
      failed: number;
      cacheHitCount: number;
      cacheMissCount: number;
      cachedNodeIds: string[];
      dispatchedNodeIds: string[];
      runs: Array<{ nodeId?: string; status: 'completed' | 'failed'; cacheHit?: boolean }>;
    };

    expect(parsed.total).toBe(3);
    expect(parsed.failed).toBe(0);
    expect(parsed.cacheHitCount).toBe(1);
    expect(parsed.cacheMissCount).toBe(2);
    expect(parsed.cachedNodeIds).toEqual(['cached-node']);
    expect(parsed.dispatchedNodeIds).toContain('fresh-node');
    expect(parsed.runs[0]).toMatchObject({ nodeId: 'cached-node', status: 'completed', cacheHit: true });
    expect(parsed.runs[1]).toMatchObject({ nodeId: 'fresh-node', status: 'completed', cacheHit: false });
    expect(parsed.runs[2]).toMatchObject({ status: 'completed', cacheHit: false });
  });
});