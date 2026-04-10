import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  const dir = await mkdtemp(join(tmpdir(), 'orchestrace-search-regressions-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'file.ts'), 'export const value = 1;\n', 'utf-8');
  return dir;
}

describe('search_files query mode and error classification regressions', () => {
  it('uses literal mode by default and via explicit queryMode=literal', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'mode-literal.txt'), 'call(value)\ncallXvalue\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const defaultResult = await toolset.executeTool({
      id: 'default-literal',
      name: 'search_files',
      arguments: { query: 'call(value)', path: 'src' },
    });
    expect(defaultResult.isError).toBeFalsy();
    expect(defaultResult.content).toContain('mode-literal.txt:1:call(value)');
    expect(defaultResult.content).not.toContain('mode-literal.txt:2:callXvalue');

    const explicitLiteral = await toolset.executeTool({
      id: 'explicit-literal',
      name: 'search_files',
      arguments: { query: 'call(value)', queryMode: 'literal', path: 'src' },
    });
    expect(explicitLiteral.isError).toBeFalsy();
    expect(explicitLiteral.content).toContain('mode-literal.txt:1:call(value)');
    expect(explicitLiteral.content).not.toContain('mode-literal.txt:2:callXvalue');
  });

  it('supports queryMode=regex and queryMode precedence over regex flag', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'src', 'mode-regex.txt'), 'call(value)\ncallvalue\n', 'utf-8');
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const regexMode = await toolset.executeTool({
      id: 'mode-regex',
      name: 'search_files',
      arguments: { query: 'call(value)', queryMode: 'regex', path: 'src' },
    });
    expect(regexMode.isError).toBeFalsy();
    expect(regexMode.content).toContain('mode-regex.txt:2:callvalue');
    expect(regexMode.content).not.toContain('mode-regex.txt:1:call(value)');

    const literalPrecedence = await toolset.executeTool({
      id: 'precedence-literal',
      name: 'search_files',
      arguments: { query: 'call(value)', regex: true, queryMode: 'literal', path: 'src' },
    });
    expect(literalPrecedence.isError).toBeFalsy();
    expect(literalPrecedence.content).toContain('mode-regex.txt:1:call(value)');
    expect(literalPrecedence.content).not.toContain('mode-regex.txt:2:callvalue');

    const regexPrecedence = await toolset.executeTool({
      id: 'precedence-regex',
      name: 'search_files',
      arguments: { query: 'call(value)', regex: false, queryMode: 'regex', path: 'src' },
    });
    expect(regexPrecedence.isError).toBeFalsy();
    expect(regexPrecedence.content).toContain('mode-regex.txt:2:callvalue');
    expect(regexPrecedence.content).not.toContain('mode-regex.txt:1:call(value)');
  });

  it('keeps no-match as non-error and marks malformed regex as error', async () => {
    const cwd = await makeWorkspace();
    const toolset = createAgentToolset({ cwd, phase: 'planning', taskType: 'code' });

    const literalNoMatch = await toolset.executeTool({
      id: 'no-match-literal',
      name: 'search_files',
      arguments: { query: 'value+', queryMode: 'literal', path: 'src' },
    });
    expect(literalNoMatch.isError).toBeFalsy();
    expect(literalNoMatch.content).toBe('(no matches)');

    const regexNoMatch = await toolset.executeTool({
      id: 'no-match-regex',
      name: 'search_files',
      arguments: { query: '^definitely-not-present$', queryMode: 'regex', path: 'src' },
    });
    expect(regexNoMatch.isError).toBeFalsy();
    expect(regexNoMatch.content).toBe('(no matches)');

    const invalidRegex = await toolset.executeTool({
      id: 'invalid-regex',
      name: 'search_files',
      arguments: { query: '(', queryMode: 'regex', path: 'src' },
    });
    expect(invalidRegex.isError).toBe(true);
    expect(invalidRegex.details).toMatchObject({
      errorType: 'invalid_regex',
      toolName: 'search_files',
      path: 'src',
    });
  });
});