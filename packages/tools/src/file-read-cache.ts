import { readFile, stat } from 'node:fs/promises';

export interface FileReadCacheKey {
  path: string;
  revision: string;
  startLine: number;
  endLine?: number;
  maxChars: number;
}

export interface CachedFileSlice {
  value: string;
  cachedAtMs: number;
}

export interface FileReadCache {
  get: (key: FileReadCacheKey) => string | undefined;
  set: (key: FileReadCacheKey, value: string) => void;
  invalidatePath: (path: string) => void;
  clear: () => void;
  size: () => number;
}

export interface SessionFileReadCacheEntry {
  content: string;
  mtimeMs: number;
  size: number;
  readAt: number;
}

export type SessionFileReadCache = Map<string, SessionFileReadCacheEntry>;

export interface FileReadCacheOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 600;

export function createFileReadCache(options?: FileReadCacheOptions): FileReadCache {
  const maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const entries = new Map<string, CachedFileSlice>();

  return {
    get: (key) => {
      const entryKey = serializeCacheKey(key);
      const existing = entries.get(entryKey);
      if (!existing) {
        return undefined;
      }

      // LRU bump by reinserting in map order.
      entries.delete(entryKey);
      entries.set(entryKey, existing);
      return existing.value;
    },
    set: (key, value) => {
      const entryKey = serializeCacheKey(key);
      if (entries.has(entryKey)) {
        entries.delete(entryKey);
      }
      entries.set(entryKey, {
        value,
        cachedAtMs: Date.now(),
      });

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (!oldestKey) {
          break;
        }
        entries.delete(oldestKey);
      }
    },
    invalidatePath: (path) => {
      const normalizedPath = normalizePath(path);
      for (const cacheKey of [...entries.keys()]) {
        if (cacheKey.startsWith(`${normalizedPath}\u001f`)) {
          entries.delete(cacheKey);
        }
      }
    },
    clear: () => {
      entries.clear();
    },
    size: () => entries.size,
  };
}

export function serializeCacheKey(key: FileReadCacheKey): string {
  return [
    normalizePath(key.path),
    key.revision,
    key.startLine,
    key.endLine ?? '',
    key.maxChars,
  ].join('\u001f');
}

export async function readFullFileWithCache(
  path: string,
  options: { cache: SessionFileReadCache },
): Promise<string> {
  const fileStat = await stat(path);
  const existing = options.cache.get(path);
  if (existing && existing.mtimeMs === fileStat.mtimeMs && existing.size === fileStat.size) {
    return existing.content;
  }

  const content = await readFile(path, 'utf-8');
  options.cache.set(path, {
    content,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    readAt: Date.now(),
  });
  return content;
}

function normalizePath(path: string): string {
  return path.replace(/\\\\/g, '/');
}