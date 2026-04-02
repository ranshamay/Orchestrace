import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentToolsetOptions, RegisteredAgentTool } from './types.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './path-utils.js';

interface FilesystemToolOptions extends AgentToolsetOptions {
  includeWriteTools: boolean;
}

export function createFilesystemTools(options: FilesystemToolOptions): RegisteredAgentTool[] {
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
        description: 'Read text from a file inside the workspace with optional line slicing.',
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
        const content = await readFile(target, 'utf-8');

        const startLine = asPositiveInteger(toolArgs.startLine) ?? 1;
        const endLine = asPositiveInteger(toolArgs.endLine);
        const maxChars = asPositiveInteger(toolArgs.maxChars) ?? 20000;

        const lines = content.split(/\r?\n/);
        const from = Math.max(1, startLine);
        const to = endLine ? Math.min(endLine, lines.length) : lines.length;
        const sliced = lines.slice(from - 1, to).join('\n');
        const trimmed = sliced.length > maxChars ? `${sliced.slice(0, maxChars)}\n... (truncated)` : sliced;

        return {
          content: trimmed,
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

          return {
            content: `Wrote ${toWorkspaceRelative(options.cwd, target)} (${content.length} chars).`,
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

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return text.split(needle).length - 1;
}