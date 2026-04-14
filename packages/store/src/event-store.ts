import { open, readdir, rm, stat, unlink, watch } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type {
  EventStore,
  SessionEvent,
  SessionEventInput,
  SessionMetadata,
} from './types.js';

const EVENTS_FILE = 'events.jsonl';
const META_FILE = 'meta.json';
const LOCK_FILE = '.events.lock';
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 20;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * File-based event store.
 *
 * Layout:
 *   <basePath>/
 *     <sessionId>/
 *       events.jsonl   — append-only event log (one JSON object per line)
 *       meta.json      — session metadata (PID, timestamps)
 *
 * Sequence numbers are per-session, monotonically increasing, assigned on append.
 * Concurrent appends to the same session are serialized via an in-memory queue
 * to guarantee monotonic seq and atomic line writes.
 */
export class FileEventStore implements EventStore {
  private readonly basePath: string;

  /** Per-session seq counter: only populated after first read/append. */
  private seqCounters = new Map<string, number>();

  /** Per-session write lock to serialize appends. */
  private writeLocks = new Map<string, Promise<void>>();

  /** Sessions that have been deleted — appends are silently dropped. */
  private deletedSessions = new Set<string>();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async append(sessionId: string, event: SessionEventInput): Promise<number> {
    return this.appendBatch(sessionId, [event]);
  }

  async appendBatch(sessionId: string, events: SessionEventInput[]): Promise<number> {
    if (events.length === 0) return this.getSeq(sessionId);
    if (this.deletedSessions.has(sessionId)) return 0;
    return this.withWriteLock(sessionId, async () => {
      if (this.deletedSessions.has(sessionId)) return 0;
      const dir = this.sessionDir(sessionId);
      await ensureDir(dir);

      return this.withFileLock(sessionId, async () => {
        const filePath = join(dir, EVENTS_FILE);

        let seq = await this.resolveSeq(sessionId, filePath, { fresh: true });
        const lines: string[] = [];
        for (const evt of events) {
          seq++;
          const full: SessionEvent = { ...evt, seq } as SessionEvent;
          lines.push(JSON.stringify(full));
        }

        // Atomic append — single write call with trailing newline
        const fd = await open(filePath, 'a');
        try {
          await fd.write(lines.join('\n') + '\n');
        } finally {
          await fd.close();
        }

        this.seqCounters.set(sessionId, seq);
        // Update fs watcher tail so it doesn't re-deliver these events
        this.fsWatcherTails.set(sessionId, seq);
        // Notify watchers
        this.notifyWatchers(sessionId, events.map((e, i) => ({
          ...e,
          seq: seq - events.length + i + 1,
        }) as SessionEvent));

        return seq;
      });
    });
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async read(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    const filePath = join(this.sessionDir(sessionId), EVENTS_FILE);
    if (!existsSync(filePath)) return [];

    const events: SessionEvent[] = [];
    let maxSeq = 0;
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as SessionEvent;
        if (evt.seq > fromSeq) events.push(evt);
        if (evt.seq > maxSeq) maxSeq = evt.seq;
      } catch {
        // Skip corrupted/partial lines
      }
    }

    // Update seq counter from disk
    const current = this.seqCounters.get(sessionId) ?? 0;
    if (maxSeq > current) this.seqCounters.set(sessionId, maxSeq);

    return events;
  }

  // ------------------------------------------------------------------
  // Watch
  // ------------------------------------------------------------------

  private watchers = new Map<string, Set<{ fromSeq: number; lastDeliveredSeq: number; cb: (event: SessionEvent) => void }>>();

  watch(sessionId: string, fromSeq: number, cb: (event: SessionEvent) => void): () => void {
    const entry = { fromSeq, lastDeliveredSeq: fromSeq, cb };
    let set = this.watchers.get(sessionId);
    if (!set) {
      set = new Set();
      this.watchers.set(sessionId, set);
    }
    set.add(entry);

    // Also start a filesystem watcher as a safety net for cross-process writes
    this.ensureFsWatcher(sessionId);
    // Polling fallback — ensures delivery even if the FS watcher fails to start
    // (common race: watch() called before the events file is created by the first append)
    this.ensurePollTimer(sessionId);

    return () => {
      set!.delete(entry);
      if (set!.size === 0) {
        this.watchers.delete(sessionId);
        this.stopFsWatcher(sessionId);
        this.stopPollTimer(sessionId);
      }
    };
  }

  private fsWatchers = new Map<string, { ac: AbortController }>();
  private fsWatcherTails = new Map<string, number>(); // last seq delivered via fs watcher
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>(); // fallback polling

  private ensureFsWatcher(sessionId: string): void {
    if (this.fsWatchers.has(sessionId)) return;

    const filePath = join(this.sessionDir(sessionId), EVENTS_FILE);
    const ac = new AbortController();
    this.fsWatchers.set(sessionId, { ac });
    this.fsWatcherTails.set(sessionId, this.seqCounters.get(sessionId) ?? 0);

    // Fire-and-forget async watcher
    void (async () => {
      try {
        const watcher = watch(filePath, { signal: ac.signal });
        for await (const event of watcher) {
          if (event.eventType === 'change') {
            await this.pollNewEvents(sessionId);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        // Watcher failed (e.g. ENOENT if file not yet created) — clear slot so
        // ensureFsWatcher can be retried on the next poll cycle.
        this.fsWatchers.delete(sessionId);
      }
    })();
  }

  /** Start a polling fallback timer that delivers cross-process writes even
   * when the FS watcher fails to start (e.g. race before file exists). */
  private ensurePollTimer(sessionId: string): void {
    if (this.pollTimers.has(sessionId)) return;
    const timer = setInterval(() => {
      // Re-arm FS watcher if it died (ENOENT race on session creation)
      this.ensureFsWatcher(sessionId);
      void this.pollNewEvents(sessionId);
    }, 3_000);
    this.pollTimers.set(sessionId, timer);
  }

  private stopPollTimer(sessionId: string): void {
    const t = this.pollTimers.get(sessionId);
    if (t !== undefined) {
      clearInterval(t);
      this.pollTimers.delete(sessionId);
    }
  }

  private async pollNewEvents(sessionId: string): Promise<void> {
    const lastDelivered = this.fsWatcherTails.get(sessionId) ?? 0;
    // Use the in-memory seq counter to avoid re-delivering events that
    // were already notified synchronously by appendBatch.
    const alreadyNotified = this.seqCounters.get(sessionId) ?? 0;
    const effectiveFrom = Math.max(lastDelivered, alreadyNotified);
    const newEvents = await this.read(sessionId, effectiveFrom);
    if (newEvents.length === 0) return;

    const maxSeq = newEvents[newEvents.length - 1].seq;
    this.fsWatcherTails.set(sessionId, maxSeq);
    this.notifyWatchers(sessionId, newEvents);
  }

  private stopFsWatcher(sessionId: string): void {
    const entry = this.fsWatchers.get(sessionId);
    if (entry) {
      entry.ac.abort();
      this.fsWatchers.delete(sessionId);
      this.fsWatcherTails.delete(sessionId);
    }
  }

  /** Force-poll a session's event log and deliver any new events to watchers.
   * Useful when the caller knows the runner has written events (e.g. after
   * receiving a process-exit notification). */
  triggerPoll(sessionId: string): void {
    void this.pollNewEvents(sessionId);
  }

  private notifyWatchers(sessionId: string, events: SessionEvent[]): void {
    const set = this.watchers.get(sessionId);
    if (!set || set.size === 0) return;
    for (const entry of set) {
      for (const evt of events) {
        if (evt.seq > entry.lastDeliveredSeq) {
          entry.lastDeliveredSeq = evt.seq;
          try { entry.cb(evt); } catch { /* watcher error is non-fatal */ }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------------

  async getMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const filePath = join(this.sessionDir(sessionId), META_FILE);
    if (!existsSync(filePath)) return null;
    const fd = await open(filePath, 'r');
    try {
      const content = await fd.readFile('utf-8');
      return JSON.parse(content) as SessionMetadata;
    } catch {
      return null;
    } finally {
      await fd.close();
    }
  }

  async setMetadata(sessionId: string, meta: SessionMetadata): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await ensureDir(dir);
    const filePath = join(dir, META_FILE);
    const fd = await open(filePath, 'w');
    try {
      await fd.write(JSON.stringify(meta, null, 2));
    } finally {
      await fd.close();
    }
  }

  // ------------------------------------------------------------------
  // Session management
  // ------------------------------------------------------------------

  async listSessions(): Promise<string[]> {
    if (!existsSync(this.basePath)) return [];
    const entries = await readdir(this.basePath, { withFileTypes: true });
    const sessions: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const eventsPath = join(this.basePath, entry.name, EVENTS_FILE);
        if (existsSync(eventsPath)) {
          sessions.push(entry.name);
        }
      }
    }
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    this.stopFsWatcher(sessionId);
    this.watchers.delete(sessionId);
    // Serialize through write lock so no concurrent append can race with rm.
    await this.withWriteLock(sessionId, async () => {
      const dir = this.sessionDir(sessionId);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    });
    this.seqCounters.delete(sessionId);
    this.writeLocks.delete(sessionId);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    return join(this.basePath, sessionId);
  }

  private getSeq(sessionId: string): number {
    return this.seqCounters.get(sessionId) ?? 0;
  }

  /** Resolve the current seq from in-memory cache or disk scan. */
  private async resolveSeq(
    sessionId: string,
    filePath: string,
    options?: { fresh?: boolean },
  ): Promise<number> {
    const fresh = options?.fresh ?? false;
    const cached = this.seqCounters.get(sessionId);
    if (!fresh && cached !== undefined) return cached;

    // Scan existing file
    if (existsSync(filePath)) {
      let maxSeq = 0;
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as { seq?: number };
          if (evt.seq && evt.seq > maxSeq) maxSeq = evt.seq;
        } catch {
          // skip corrupted lines
        }
      }
      this.seqCounters.set(sessionId, maxSeq);
      return maxSeq;
    }

    this.seqCounters.set(sessionId, 0);
    return 0;
  }

  /** Serialize writes per session to ensure monotonic seq assignment. */
  private async withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(sessionId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.writeLocks.set(sessionId, next);

    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  private async withFileLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = join(this.sessionDir(sessionId), LOCK_FILE);
    const startedAt = Date.now();

    for (;;) {
      let lockFd;
      try {
        lockFd = await open(lockPath, 'wx');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw error;
        }

        const isStale = await this.isStaleLock(lockPath);
        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }

        if (Date.now() - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring event lock for session ${sessionId}.`);
        }

        await sleep(LOCK_RETRY_MS);
        continue;
      }

      try {
        return await fn();
      } finally {
        await lockFd.close();
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }

  private async isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const lockStats = await stat(lockPath);
      return Date.now() - lockStats.mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
