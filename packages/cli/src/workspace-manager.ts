import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

interface WorkspaceStore {
  version: number;
  activeWorkspaceId: string;
  workspaces: WorkspaceEntry[];
}

const STORE_VERSION = 1;

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly storePath: string;

  constructor(startDir: string = process.cwd()) {
    this.rootDir = findWorkspaceRoot(startDir);
    this.storePath = join(this.rootDir, '.orchestrace', 'workspaces.json');
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getStorePath(): string {
    return this.storePath;
  }

  async list(): Promise<{ activeWorkspaceId: string; workspaces: WorkspaceEntry[] }> {
    const store = await this.readStore();
    return {
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: [...store.workspaces],
    };
  }

  async getActiveWorkspace(): Promise<WorkspaceEntry> {
    const store = await this.readStore();
    const active = store.workspaces.find((workspace) => workspace.id === store.activeWorkspaceId);
    if (active) {
      return active;
    }

    const fallback = store.workspaces[0];
    if (!fallback) {
      throw new Error('No workspace configured');
    }

    store.activeWorkspaceId = fallback.id;
    await this.writeStore(store);
    return fallback;
  }

  async addWorkspace(pathInput: string, nameInput?: string): Promise<WorkspaceEntry> {
    const normalizedPath = await normalizeWorkspacePath(pathInput);
    const store = await this.readStore();
    const existing = store.workspaces.find((workspace) => workspace.path === normalizedPath);

    if (existing) {
      if (nameInput && nameInput.trim()) {
        existing.name = nameInput.trim();
      }
      store.activeWorkspaceId = existing.id;
      await this.writeStore(store);
      return existing;
    }

    const entry: WorkspaceEntry = {
      id: randomUUID(),
      name: nameInput?.trim() || basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
      createdAt: now(),
    };

    store.workspaces.push(entry);
    store.activeWorkspaceId = entry.id;
    await this.writeStore(store);
    return entry;
  }

  async selectWorkspace(identifier: string): Promise<WorkspaceEntry> {
    const store = await this.readStore();
    const entry = await findWorkspaceByIdentifier(store, identifier);
    if (!entry) {
      throw new Error(`Workspace not found: ${identifier}`);
    }

    store.activeWorkspaceId = entry.id;
    await this.writeStore(store);
    return entry;
  }

  async removeWorkspace(identifier: string): Promise<{ removedId: string; activeWorkspaceId: string }> {
    const store = await this.readStore();
    const entry = await findWorkspaceByIdentifier(store, identifier);
    if (!entry) {
      throw new Error(`Workspace not found: ${identifier}`);
    }

    if (store.workspaces.length === 1) {
      throw new Error('Cannot remove the last workspace');
    }

    store.workspaces = store.workspaces.filter((workspace) => workspace.id !== entry.id);
    if (store.activeWorkspaceId === entry.id) {
      store.activeWorkspaceId = store.workspaces[0].id;
    }

    await this.writeStore(store);
    return {
      removedId: entry.id,
      activeWorkspaceId: store.activeWorkspaceId,
    };
  }

  private async readStore(): Promise<WorkspaceStore> {
    if (!existsSync(this.storePath)) {
      const initial = this.buildDefaultStore();
      await this.writeStore(initial);
      return initial;
    }

    const raw = await readFile(this.storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceStore>;

    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((workspace): workspace is WorkspaceEntry => {
        return Boolean(
          workspace
            && typeof workspace.id === 'string'
            && typeof workspace.name === 'string'
            && typeof workspace.path === 'string'
            && typeof workspace.createdAt === 'string',
        );
      })
      : [];

    if (workspaces.length === 0) {
      const initial = this.buildDefaultStore();
      await this.writeStore(initial);
      return initial;
    }

    const activeWorkspaceId = typeof parsed.activeWorkspaceId === 'string'
      ? parsed.activeWorkspaceId
      : workspaces[0].id;

    const store: WorkspaceStore = {
      version: STORE_VERSION,
      activeWorkspaceId,
      workspaces,
    };

    if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
      store.activeWorkspaceId = workspaces[0].id;
      await this.writeStore(store);
    }

    return store;
  }

  private buildDefaultStore(): WorkspaceStore {
    const defaultWorkspace: WorkspaceEntry = {
      id: randomUUID(),
      name: basename(this.rootDir) || this.rootDir,
      path: this.rootDir,
      createdAt: now(),
    };

    return {
      version: STORE_VERSION,
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [defaultWorkspace],
    };
  }

  private async writeStore(store: WorkspaceStore): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }
}

async function findWorkspaceByIdentifier(store: WorkspaceStore, identifier: string): Promise<WorkspaceEntry | undefined> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return undefined;
  }

  const byId = store.workspaces.find((workspace) => workspace.id === trimmed);
  if (byId) {
    return byId;
  }

  const byName = store.workspaces.find((workspace) => workspace.name === trimmed);
  if (byName) {
    return byName;
  }

  const pathCandidate = resolve(trimmed);
  return store.workspaces.find((workspace) => workspace.path === pathCandidate);
}

async function normalizeWorkspacePath(pathInput: string): Promise<string> {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    throw new Error('Workspace path cannot be empty');
  }

  const resolvedPath = resolve(trimmed);
  const stats = await stat(resolvedPath).catch(() => undefined);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Workspace path does not exist or is not a directory: ${resolvedPath}`);
  }

  return realpath(resolvedPath).catch(() => resolvedPath);
}

function now(): string {
  return new Date().toISOString();
}

export function findWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }

    current = parent;
  }
}