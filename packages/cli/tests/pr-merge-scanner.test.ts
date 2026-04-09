import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PrMergeScanner, extractPrInfoFromMessages } from '../src/pr-merge-scanner.js';
import type { EventStore, SessionEvent, SessionEventInput, SessionMetadata } from '@orchestrace/store';

class InMemoryEventStore implements EventStore {
  private eventsBySession = new Map<string, SessionEvent[]>();
  private seqBySession = new Map<string, number>();

  async append(sessionId: string, event: SessionEventInput): Promise<number> {
    return this.appendBatch(sessionId, [event]);
  }

  async appendBatch(sessionId: string, events: SessionEventInput[]): Promise<number> {
    const existing = this.eventsBySession.get(sessionId) ?? [];
    let seq = this.seqBySession.get(sessionId) ?? 0;
    for (const event of events) {
      seq += 1;
      existing.push({ ...event, seq } as SessionEvent);
    }
    this.eventsBySession.set(sessionId, existing);
    this.seqBySession.set(sessionId, seq);
    return seq;
  }

  async read(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return events.filter((event) => event.seq > fromSeq);
  }

  watch(_sessionId: string, _fromSeq: number, _cb: (event: SessionEvent) => void): () => void {
    return () => {};
  }

  triggerPoll(_sessionId: string): void {}

  async listSessions(): Promise<string[]> {
    return [...this.eventsBySession.keys()];
  }

  async getMetadata(_sessionId: string): Promise<SessionMetadata | null> {
    return null;
  }

  async setMetadata(_sessionId: string, _meta: SessionMetadata): Promise<void> {}

  async deleteSession(sessionId: string): Promise<void> {
    this.eventsBySession.delete(sessionId);
    this.seqBySession.delete(sessionId);
  }
}

function createdEvent(sessionId: string, deliveryStrategy: 'pr-only' | 'merge-after-ci' = 'pr-only'): SessionEventInput {
  return {
    time: new Date().toISOString(),
    type: 'session:created',
    payload: {
      config: {
        id: sessionId,
        workspaceId: 'ws-1',
        workspaceName: 'repo',
        workspacePath: '/tmp/repo',
        prompt: 'Implement feature',
        provider: 'github-copilot',
        model: 'gpt-5',
        planningProvider: 'github-copilot',
        planningModel: 'gpt-5',
        implementationProvider: 'github-copilot',
        implementationModel: 'gpt-5',
        deliveryStrategy,
        autoApprove: false,
        adaptiveConcurrency: false,
        batchConcurrency: 4,
        batchMinConcurrency: 1,
        creationReason: 'start',
      },
    },
  };
}

describe('extractPrInfoFromMessages', () => {
  it('extracts owner/repo/number from system message URL', () => {
    const pr = extractPrInfoFromMessages([
      {
        role: 'system',
        content: 'PR #42 was created, and GitHub CI checks passed: https://github.com/acme/widgets/pull/42',
        time: new Date().toISOString(),
      },
    ]);

    expect(pr).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      prNumber: 42,
      url: 'https://github.com/acme/widgets/pull/42',
    });
  });

  it('returns undefined when no PR URL exists', () => {
    const pr = extractPrInfoFromMessages([
      {
        role: 'assistant',
        content: 'No PR here',
        time: new Date().toISOString(),
      },
    ]);

    expect(pr).toBeUndefined();
  });
});

describe('PrMergeScanner', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('marks completed pr-only session as merged when GitHub PR is merged', async () => {
    const store = new InMemoryEventStore();
    const id = 'sess-1';
    await store.appendBatch(id, [
      createdEvent(id, 'pr-only'),
      { time: new Date().toISOString(), type: 'session:chat-thread-created', payload: { provider: 'github-copilot', model: 'gpt-5', workspacePath: '/tmp/repo', taskPrompt: 'x' } },
      { time: new Date().toISOString(), type: 'session:chat-message', payload: { message: { role: 'system', content: 'PR #10 was created: https://github.com/acme/widgets/pull/10', time: new Date().toISOString() } } },
      { time: new Date().toISOString(), type: 'session:status-change', payload: { status: 'completed' } },
    ]);

    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ merged: true }),
    });

    const scanner = new PrMergeScanner({
      eventStore: store,
      resolveGithubToken: async () => 'token-123',
      scanIntervalMs: 999999,
    });

    const mergedSessions: string[] = [];
    scanner.onSessionMerged((sessionId) => mergedSessions.push(sessionId));

    await scanner.scanOnce();

    const events = await store.read(id);
    const statuses = events
      .filter((event) => event.type === 'session:status-change')
      .map((event) => (event.type === 'session:status-change' ? event.payload.status : undefined));

    expect(statuses).toEqual(['completed', 'merged']);
    expect(mergedSessions).toEqual([id]);
  });

  it('skips merge-after-ci sessions', async () => {
    const store = new InMemoryEventStore();
    const id = 'sess-merge-after-ci';
    await store.appendBatch(id, [
      createdEvent(id, 'merge-after-ci'),
      { time: new Date().toISOString(), type: 'session:chat-thread-created', payload: { provider: 'github-copilot', model: 'gpt-5', workspacePath: '/tmp/repo', taskPrompt: 'x' } },
      { time: new Date().toISOString(), type: 'session:chat-message', payload: { message: { role: 'system', content: 'PR #10 was merged: https://github.com/acme/widgets/pull/10', time: new Date().toISOString() } } },
      { time: new Date().toISOString(), type: 'session:status-change', payload: { status: 'completed' } },
    ]);

    const scanner = new PrMergeScanner({
      eventStore: store,
      resolveGithubToken: async () => 'token-123',
      scanIntervalMs: 999999,
    });

    await scanner.scanOnce();

    const events = await store.read(id);
    const statuses = events
      .filter((event) => event.type === 'session:status-change')
      .map((event) => (event.type === 'session:status-change' ? event.payload.status : undefined));

    expect(statuses).toEqual(['completed']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
}