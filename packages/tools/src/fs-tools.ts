import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentToolsetOptions, RegisteredAgentTool } from './types.js';
import type { FileReadCache } from './file-read-cache.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './path-utils.js';
import { runCommand } from './command-tools/command-runner.js';

interface FilesystemToolOptions extends AgentToolsetOptions {
  includeWriteTools: boolean;
}

const DEFAULT_READ_MAX_CHARS = 20000;
const DEFAULT_READ_BATCH_MAX_CHARS = 8000;
const DEFAULT_BATCH_READ_CONCURRENCY = 16;
const DEFAULT_BATCH_WRITE_CONCURRENCY = 12;
const DEFAULT_BATCH_EDIT_CONCURRENCY = 12;
const MAX_BATCH_CONCURRENCY = 128;
const MAX_BATCH_ITEMS = 1000;
const DEFAULT_BATCH_MIN_CONCURRENCY = 1;

export function createFilesystemTools(options: FilesystemToolOptions): RegisteredAgentTool[] {
  const resolveRevision = createRevisionResolver(options.cwd);
  const fileReadCache = options.fileReadCache;
  const tools: RegisteredAgentTool[] = [
    {
      tool: {
        name: 'list_directory',
        description: 'List files and folders for a path inside the workspace.',
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: 'Relative workspace path. Defaults to current directory.' })),
          includeHidden: Type.Optional(Type.Boolean({ description: 'Include entries starting with a dot.' })),
        }),
      },
      execute: async (toolArgs) => {
        const path = asString(toolArgs.path) ?? '.';
        const includeHidden = Boolean(toolArgs.includeHidden);
        const target = resolveWorkspacePath(options.cwd, path);
        const entries = await readdir(target, { withFileTypes: true });

        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .filter((entry) => includeHidden || !entry.startsWith('.'))
          .sort((a, b) => a.localeCompare(b));

        return {
          content: names.length > 0
            ? names.join('\n')
            : '(empty directory)',
        };
      },
    },
    {
      tool: {
        name: 'read_file',
        description: 'Read text from one file inside the workspace with optional line slicing. Prefer read_files for multi-file reads.',
        parameters: Type.Object({
          path: Type.String({ description: 'Relative path to file.' }),
          startLine: Type.Optional(Type.Number({ minimum: 1 })),
          endLine: Type.Optional(Type.Number({ minimum: 1 })),
          maxChars: Type.Optional(Type.Number({ minimum: 200, maximum: 200000 })),
        }),
      },
      execute: async (toolArgs) => {
        const path = asRequiredString(toolArgs.path, 'path');
        const target = resolveWorkspacePath(options.cwd, path);
        const startLine = asPositiveInteger(toolArgs.startLine) ?? 1;
        const endLine = asPositiveInteger(toolArgs.endLine);
        const maxChars = asPositiveInteger(toolArgs.maxChars) ?? DEFAULT_READ_MAX_CHARS;
        const trimmed = await readWorkspaceFileSlice(target, { startLine, endLine, maxChars }, {
          fileReadCache,
          resolveRevision,
        });

        return {
          content: trimmed,
        };
      },
    },
    {
      tool: {
        name: 'read_files',
        description: 'Read multiple files in parallel with optional line slicing per file. Use this for multi-file analysis to reduce latency.',
        parameters: Type.Object({
          files: Type.Array(
            Type.Object({
              path: Type.String({ description: 'Relative path to file.' }),
              startLine: Type.Optional(Type.Number({ minimum: 1 })),
              endLine: Type.Optional(Type.Number({ minimum: 1 })),
              maxChars: Type.Optional(Type.Number({ minimum: 200, maximum: 200000 })),
            }),
            { minItems: 1, maxItems: MAX_BATCH_ITEMS },
          ),
          concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
          adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on failures while processing the batch.' })),
          minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
        }),
      },
      execute: async (toolArgs) => {
        const files = asReadBatchRequests(toolArgs.files);
        const requestedConcurrency = asPositiveInteger(toolArgs.concurrency)
          ?? options.batchConcurrency
          ?? DEFAULT_BATCH_READ_CONCURRENCY;
        const concurrency = clampConcurrency(requestedConcurrency);
        const adaptiveConcurrency = asBoolean(toolArgs.adaptiveConcurrency)
          ?? options.adaptiveConcurrency
          ?? false;
        const minConcurrency = clampConcurrency(
          asPositiveInteger(toolArgs.minConcurrency)
            ?? options.batchMinConcurrency
            ?? DEFAULT_BATCH_MIN_CONCURRENCY,
        );

        const mapper = async (request: ReadBatchRequest) => {
          const target = resolveWorkspacePath(options.cwd, request.path);
          try {
            const content = await readWorkspaceFileSlice(target, {
              startLine: request.startLine,
              endLine: request.endLine,
              maxChars: request.maxChars,
            }, {
              fileReadCache,
              resolveRevision,
            });
            return {
              path: request.path,
              ok: true,
              content,
            };
          } catch (error) {
            return {
              path: request.path,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        };

        const batchRun = adaptiveConcurrency
          ? await mapWithAdaptiveConcurrency(files, {
              initialConcurrency: concurrency,
              minConcurrency,
              maxConcurrency: MAX_BATCH_CONCURRENCY,
            }, mapper, (entry) => !entry.ok)
          : {
              results: await mapWithConcurrency(files, concurrency, mapper),
              finalConcurrency: concurrency,
              windows: 1,
            };

        const fileResults = batchRun.results;

        const failures = fileResults.filter((entry) => !entry.ok).length;
        return {
          content: JSON.stringify({
            total: fileResults.length,
            concurrency,
            adaptiveConcurrency,
            minConcurrency,
            finalConcurrency: batchRun.finalConcurrency,
            windows: batchRun.windows,
            successes: fileResults.length - failures,
            failures,
            files: fileResults,
          }, null, 2),
          isError: failures > 0,
        };
      },
    },
  ];

  if (options.includeWriteTools) {
    tools.push(
      {
        tool: {
          name: 'write_file',
          description: 'Create or overwrite a file inside the workspace.',
          parameters: Type.Object({
            path: Type.String({ description: 'Relative path to file.' }),
            content: Type.String({ description: 'Full file content to write.' }),
          }),
        },
        execute: async (toolArgs) => {
          const path = asRequiredString(toolArgs.path, 'path');
          const content = asRequiredString(toolArgs.content, 'content');
          const target = resolveWorkspacePath(options.cwd, path);

          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf-8');
          invalidateCacheForPath(fileReadCache, target);

          return {
            content: `Wrote ${toWorkspaceRelative(options.cwd, target)} (${content.length} chars).`,
          };
        },
      },
      {
        tool: {
          name: 'write_files',
          description: 'Create or overwrite multiple files in parallel.',
          parameters: Type.Object({
            files: Type.Array(
              Type.Object({
                path: Type.String({ description: 'Relative path to file.' }),
                content: Type.String({ description: 'Full file content to write.' }),
              }),
                { minItems: 1, maxItems: MAX_BATCH_ITEMS },
            ),
            concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
            adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on failures while processing the batch.' })),
            minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
          }),
        },
        execute: async (toolArgs) => {
          const files = asWriteBatchRequests(toolArgs.files);
          const duplicates = findDuplicateTargets(options.cwd, files.map((entry) => entry.path));
          if (duplicates.length > 0) {
            return {
              content: `Duplicate paths are not allowed: ${duplicates.join(', ')}`,
              isError: true,
            };
          }

          const requestedConcurrency = asPositiveInteger(toolArgs.concurrency)
            ?? options.batchConcurrency
            ?? DEFAULT_BATCH_WRITE_CONCURRENCY;
          const concurrency = clampConcurrency(requestedConcurrency);
          const adaptiveConcurrency = asBoolean(toolArgs.adaptiveConcurrency)
            ?? options.adaptiveConcurrency
            ?? false;
          const minConcurrency = clampConcurrency(
            asPositiveInteger(toolArgs.minConcurrency)
              ?? options.batchMinConcurrency
              ?? DEFAULT_BATCH_MIN_CONCURRENCY,
          );

          const mapper = async (request: WriteBatchRequest) => {
            const target = resolveWorkspacePath(options.cwd, request.path);
            try {
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, request.content, 'utf-8');
              invalidateCacheForPath(fileReadCache, target);
              return {
                path: request.path,
                ok: true,
                chars: request.content.length,
              };
            } catch (error) {
              return {
                path: request.path,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          };

          const batchRun = adaptiveConcurrency
            ? await mapWithAdaptiveConcurrency(files, {
                initialConcurrency: concurrency,
                minConcurrency,
                maxConcurrency: MAX_BATCH_CONCURRENCY,
              }, mapper, (entry) => !entry.ok)
            : {
                results: await mapWithConcurrency(files, concurrency, mapper),
                finalConcurrency: concurrency,
                windows: 1,
              };

          const results = batchRun.results;

          const failures = results.filter((entry) => !entry.ok).length;
          return {
            content: JSON.stringify({
              total: results.length,
              concurrency,
              adaptiveConcurrency,
              minConcurrency,
              finalConcurrency: batchRun.finalConcurrency,
              windows: batchRun.windows,
              successes: results.length - failures,
              failures,
              files: results,
            }, null, 2),
            isError: failures > 0,
          };
        },
      },
      {
        tool: {
          name: 'edit_files',
          description: 'Apply in-place text replacements across multiple files in parallel.',
          parameters: Type.Object({
            files: Type.Array(
              Type.Object({
                path: Type.String({ description: 'Relative path to file.' }),
                oldText: Type.String({ description: 'Exact old text to replace.' }),
                newText: Type.String({ description: 'Replacement text.' }),
                replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences instead of the first match.' })),
              }),
              { minItems: 1, maxItems: MAX_BATCH_ITEMS },
            ),
            concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
            adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on failures while processing the batch.' })),
            minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_CONCURRENCY })),
          }),
        },
        execute: async (toolArgs) => {
          const files = asEditBatchRequests(toolArgs.files);
          const duplicates = findDuplicateTargets(options.cwd, files.map((entry) => entry.path));
          if (duplicates.length > 0) {
            return {
              content: `Duplicate paths are not allowed: ${duplicates.join(', ')}`,
              isError: true,
            };
          }

          const requestedConcurrency = asPositiveInteger(toolArgs.concurrency)
            ?? options.batchConcurrency
            ?? DEFAULT_BATCH_EDIT_CONCURRENCY;
          const concurrency = clampConcurrency(requestedConcurrency);
          const adaptiveConcurrency = asBoolean(toolArgs.adaptiveConcurrency)
            ?? options.adaptiveConcurrency
            ?? false;
          const minConcurrency = clampConcurrency(
            asPositiveInteger(toolArgs.minConcurrency)
              ?? options.batchMinConcurrency
              ?? DEFAULT_BATCH_MIN_CONCURRENCY,
          );

          const mapper = async (request: EditBatchRequest) => {
            const target = resolveWorkspacePath(options.cwd, request.path);
            try {
              const current = await readFile(target, 'utf-8');
              const occurrences = countOccurrences(current, request.oldText);
              if (occurrences === 0) {
                return {
                  path: request.path,
                  ok: false,
                  error: `No matching text found in ${request.path}.`,
                };
              }

              const updated = request.replaceAll
                ? current.split(request.oldText).join(request.newText)
                : current.replace(request.oldText, request.newText);
              await writeFile(target, updated, 'utf-8');
              invalidateCacheForPath(fileReadCache, target);

              return {
                path: request.path,
                ok: true,
                replaceAll: request.replaceAll,
                replacements: request.replaceAll ? occurrences : 1,
              };
            } catch (error) {
              return {
                path: request.path,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          };

          const batchRun = adaptiveConcurrency
            ? await mapWithAdaptiveConcurrency(files, {
                initialConcurrency: concurrency,
                minConcurrency,
                maxConcurrency: MAX_BATCH_CONCURRENCY,
              }, mapper, (entry) => !entry.ok)
            : {
                results: await mapWithConcurrency(files, concurrency, mapper),
                finalConcurrency: concurrency,
                windows: 1,
              };

          const results = batchRun.results;

          const failures = results.filter((entry) => !entry.ok).length;
          return {
            content: JSON.stringify({
              total: results.length,
              concurrency,
              adaptiveConcurrency,
              minConcurrency,
              finalConcurrency: batchRun.finalConcurrency,
              windows: batchRun.windows,
              successes: results.length - failures,
              failures,
              files: results,
            }, null, 2),
            isError: failures > 0,
          };
        },
      },
      {
        tool: {
          name: 'edit_file',
          description: 'Apply an in-place text replacement inside a workspace file.',
          parameters: Type.Object({
            path: Type.String({ description: 'Relative path to file.' }),
            oldText: Type.String({ description: 'Exact old text to replace.' }),
            newText: Type.String({ description: 'Replacement text.' }),
            replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences instead of the first match.' })),
          }),
        },
        execute: async (toolArgs) => {
          const path = asRequiredString(toolArgs.path, 'path');
          const oldText = asRequiredString(toolArgs.oldText, 'oldText');
          const newText = asRequiredString(toolArgs.newText, 'newText');
          const replaceAll = Boolean(toolArgs.replaceAll);
          const target = resolveWorkspacePath(options.cwd, path);

          const current = await readFile(target, 'utf-8');
          const occurrences = countOccurrences(current, oldText);

          if (occurrences === 0) {
            return {
              content: `No matching text found in ${toWorkspaceRelative(options.cwd, target)}.`,
              isError: true,
            };
          }

          const updated = replaceAll
            ? current.split(oldText).join(newText)
            : current.replace(oldText, newText);

          await writeFile(target, updated, 'utf-8');
          invalidateCacheForPath(fileReadCache, target);

          return {
            content: replaceAll
              ? `Replaced ${occurrences} occurrence(s) in ${toWorkspaceRelative(options.cwd, target)}.`
              : `Replaced first occurrence in ${toWorkspaceRelative(options.cwd, target)}.`,
          };
        },
      },
    );
  }

  return tools;
}

interface ReadBatchRequest {
  path: string;
  startLine: number;
  endLine?: number;
  maxChars: number;
}

interface WriteBatchRequest {
  path: string;
  content: string;
}

interface EditBatchRequest {
  path: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

async function readWorkspaceFileSlice(
  target: string,
  options: {
    startLine: number;
    endLine?: number;
    maxChars: number;
  },
  cacheOptions: {
    fileReadCache?: FileReadCache;
    resolveRevision: () => Promise<string>;
  },
): Promise<string> {
  const normalized = {
    startLine: Math.max(1, options.startLine),
    endLine: options.endLine,
    maxChars: options.maxChars,
  };

  if (cacheOptions.fileReadCache) {
    const revision = await cacheOptions.resolveRevision();
    const cached = cacheOptions.fileReadCache.get({
      path: target,
      revision,
      startLine: normalized.startLine,
      endLine: normalized.endLine,
      maxChars: normalized.maxChars,
    });
    if (cached !== undefined) {
      return cached;
    }

    const computed = await readWorkspaceFileSliceUncached(target, normalized);
    cacheOptions.fileReadCache.set({
      path: target,
      revision,
      startLine: normalized.startLine,
      endLine: normalized.endLine,
      maxChars: normalized.maxChars,
    }, computed);
    return computed;
  }

  return readWorkspaceFileSliceUncached(target, normalized);
}

async function readWorkspaceFileSliceUncached(
  target: string,
  options: {
    startLine: number;
    endLine?: number;
    maxChars: number;
  },
): Promise<string> {
  const content = await readFile(target, 'utf-8');
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, options.startLine);
  const to = options.endLine ? Math.min(options.endLine, lines.length) : lines.length;
  const sliced = lines.slice(from - 1, to).join('\n');
  return sliced.length > options.maxChars
    ? `${sliced.slice(0, options.maxChars)}\n... (truncated)`
    : sliced;
}

function createRevisionResolver(cwd: string): () => Promise<string> {
  let cachedRevision: string | undefined;

  return async () => {
    if (cachedRevision) {
      return cachedRevision;
    }

    try {
      const result = await runCommand('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeoutMs: 5_000,
      });
      const revision = result.exitCode === 0
        ? result.stdout.trim()
        : '';
      cachedRevision = revision || 'no-git-revision';
    } catch {
      cachedRevision = 'no-git-revision';
    }

    return cachedRevision;
  };
}

function invalidateCacheForPath(cache: FileReadCache | undefined, target: string): void {
  cache?.invalidatePath(target);
}

function asReadBatchRequests(value: unknown): ReadBatchRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Missing files');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid files[${index}]`);
    }

    return {
      path: asRequiredString(entry.path, `files[${index}].path`),
      startLine: asPositiveInteger(entry.startLine) ?? 1,
      endLine: asPositiveInteger(entry.endLine),
      maxChars: asPositiveInteger(entry.maxChars) ?? DEFAULT_READ_BATCH_MAX_CHARS,
    };
  });
}

function asWriteBatchRequests(value: unknown): WriteBatchRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Missing files');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid files[${index}]`);
    }

    return {
      path: asRequiredString(entry.path, `files[${index}].path`),
      content: asRequiredString(entry.content, `files[${index}].content`),
    };
  });
}

function asEditBatchRequests(value: unknown): EditBatchRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Missing files');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid files[${index}]`);
    }

    return {
      path: asRequiredString(entry.path, `files[${index}].path`),
      oldText: asRequiredString(entry.oldText, `files[${index}].oldText`),
      newText: asRequiredString(entry.newText, `files[${index}].newText`),
      replaceAll: Boolean(entry.replaceAll),
    };
  });
}

function clampConcurrency(value: number): number {
  return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, value));
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function mapWithAdaptiveConcurrency<T, U>(
  values: readonly T[],
  options: {
    initialConcurrency: number;
    minConcurrency: number;
    maxConcurrency: number;
  },
  mapper: (value: T, index: number) => Promise<U>,
  isFailure: (result: U) => boolean,
): Promise<{ results: U[]; finalConcurrency: number; windows: number }> {
  if (values.length === 0) {
    return { results: [], finalConcurrency: options.initialConcurrency, windows: 0 };
  }

  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let currentConcurrency = clampConcurrency(options.initialConcurrency);
  const minConcurrency = Math.max(1, Math.min(options.maxConcurrency, options.minConcurrency));
  let windows = 0;

  while (nextIndex < values.length) {
    const start = nextIndex;
    const end = Math.min(values.length, start + currentConcurrency);
    const indexes = [] as number[];
    for (let index = start; index < end; index += 1) {
      indexes.push(index);
    }

    const batchResults = await Promise.all(indexes.map(async (index) => mapper(values[index], index)));
    for (let offset = 0; offset < batchResults.length; offset += 1) {
      results[indexes[offset]] = batchResults[offset];
    }

    windows += 1;
    const failures = batchResults.reduce((count, result) => (isFailure(result) ? count + 1 : count), 0);
    currentConcurrency = failures === 0
      ? Math.min(options.maxConcurrency, currentConcurrency * 2)
      : Math.max(minConcurrency, Math.floor(currentConcurrency / 2));
    nextIndex = end;
  }

  return {
    results,
    finalConcurrency: currentConcurrency,
    windows,
  };
}

function findDuplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const path of paths) {
    if (seen.has(path)) {
      duplicates.add(path);
      continue;
    }

    seen.add(path);
  }

  return [...duplicates].sort((a, b) => a.localeCompare(b));
}

function findDuplicateTargets(cwd: string, paths: readonly string[]): string[] {
  const resolvedToInput = new Map<string, string>();
  const duplicates = new Set<string>();

  for (const path of paths) {
    const resolved = resolveWorkspacePath(cwd, path);
    const first = resolvedToInput.get(resolved);
    if (first) {
      duplicates.add(first);
      duplicates.add(path);
      continue;
    }

    resolvedToInput.set(resolved, path);
  }

  return [...duplicates].sort((a, b) => a.localeCompare(b));
}

function asRequiredString(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) {
    throw new Error(`Missing ${field}`);
  }

  return parsed;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return text.split(needle).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}