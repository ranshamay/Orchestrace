import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveWorkspacePath(root: string, candidate: string): string {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, resolved);

  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }

  return resolved;
}

export function toWorkspaceRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  return rel.length === 0 ? '.' : rel;
}

export function sanitizeForPathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}