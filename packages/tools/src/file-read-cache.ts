import { readFile, stat } from 'node:fs/promises';

export interface FileReadCacheEntry {
  content: string;
  mtimeMs: number;
  size: number;
  readAt: number;
}

export type SessionFileReadCache = Map<string, FileReadCacheEntry>;

export interface ReadFullFileWithCacheOptions {
  cache?: SessionFileReadCache;
}

export async function readFullFileWithCache(
  absolutePath: string,
  options: ReadFullFileWithCacheOptions = {},
): Promise<string> {
  const metadata = await stat(absolutePath);
  const currentMtimeMs = metadata.mtimeMs;
  const currentSize = metadata.size;
  const existing = options.cache?.get(absolutePath);

  if (existing && existing.mtimeMs === currentMtimeMs && existing.size === currentSize) {
    return existing.content;
  }

  const content = await readFile(absolutePath, 'utf-8');
  options.cache?.set(absolutePath, {
    content,
    mtimeMs: currentMtimeMs,
    size: currentSize,
    readAt: Date.now(),
  });

  return content;
}