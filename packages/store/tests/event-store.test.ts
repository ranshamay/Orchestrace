import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventStore } from '../src/event-store.js';
import { materializeSession, applyEvent } from '../src/materializer.js';
import type {
  SessionEvent,
  SessionEventInput,
  SessionConfig,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    workspacePath: '/tmp/test',
    prompt: 'Fix the bug',
    provider: 'openai',
    model: 'gpt-4',
    autoApprove: false,
    adaptiveConcurrency: false,
    batchConcurrency: 4,
    batchMinConcurrency: 1,
    creationReason: 'start',
    ...overrides,
  };
}

function now(): string {
  return new Date().toISOString();
}

function createdEvent(config?: Partial<SessionConfig>): SessionEventInput {
  return {
    time: now(),
    type: 'session:created',
    payload: { config: makeConfig(config) },
  };
}

// ---------------------------------------------------------------------------
// FileEventStore
// ---------------------------------------------------------------------------

describe('FileEventStore', () => {
  let tmpDir: string;
  let store: FileEventStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'event-store-test-'));
    store = new FileEventStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('append and read roundtrip', async () => {
    const evt = createdEvent();
    const seq = await store.append('sess-1', evt);
    expect(seq).toBe(1);

    const events = await store.read('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
    expect(events[0].type).toBe('session:created');
    expect(events[0].payload).toEqual(evt.payload);
  });

  it('assigns monotonically increasing seq numbers', async () => {
    await store.append('sess-1', createdEvent());
    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'running' },
    });
    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'completed' },
    });

    const events = await store.read('sess-1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('appendBatch writes multiple events atomically', async () => {
    const batch: SessionEventInput[] = [
      createdEvent(),
      { time: now(), type: 'session:started', payload: { pid: 1234 } },
      { time: now(), type: 'session:status-change', payload: { status: 'running' } },
    ];

    const lastSeq = await store.appendBatch('sess-1', batch);
    expect(lastSeq).toBe(3);

    const events = await store.read('sess-1');
    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(1);
    expect(events[2].seq).toBe(3);
  });

  it('read with fromSeq filters events', async () => {
    await store.appendBatch('sess-1', [
      createdEvent(),
      { time: now(), type: 'session:started', payload: {} },
      { time: now(), type: 'session:status-change', payload: { status: 'completed' } },
    ]);

    const events = await store.read('sess-1', 2);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(3);
  });

  it('read returns empty array for nonexistent session', async () => {
    const events = await store.read('nonexistent');
    expect(events).toEqual([]);
  });

  it('listSessions returns session IDs', async () => {
    await store.append('sess-1', createdEvent());
    await store.append('sess-2', createdEvent({ id: 'sess-2' }));

    const sessions = await store.listSessions();
    expect(sessions.sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('listSessions returns empty for nonexistent base path', async () => {
    const emptyStore = new FileEventStore(join(tmpDir, 'nonexistent'));
    const sessions = await emptyStore.listSessions();
    expect(sessions).toEqual([]);
  });

  it('metadata roundtrip', async () => {
    await store.setMetadata('sess-1', {
      id: 'sess-1',
      pid: 42,
      createdAt: now(),
      workspacePath: '/tmp/test',
    });

    const meta = await store.getMetadata('sess-1');
    expect(meta).not.toBeNull();
    expect(meta!.pid).toBe(42);
  });

  it('getMetadata returns null for nonexistent session', async () => {
    const meta = await store.getMetadata('nonexistent');
    expect(meta).toBeNull();
  });

  it('deleteSession removes all data', async () => {
    await store.append('sess-1', createdEvent());
    await store.setMetadata('sess-1', {
      id: 'sess-1',
      createdAt: now(),
      workspacePath: '/tmp/test',
    });

    await store.deleteSession('sess-1');

    const events = await store.read('sess-1');
    expect(events).toEqual([]);
    const meta = await store.getMetadata('sess-1');
    expect(meta).toBeNull();
    const sessions = await store.listSessions();
    expect(sessions).toEqual([]);
  });

  it('watch delivers new events', async () => {
    await store.append('sess-1', createdEvent());

    const received: number[] = [];
    const unsub = store.watch('sess-1', 0, (event) => {
      received.push(event.seq);
    });

    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'running' },
    });
    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'completed' },
    });

    unsub();

    expect(received).toEqual([2, 3]);
  });

  it('watch filters by fromSeq', async () => {
    await store.appendBatch('sess-1', [
      createdEvent(),
      { time: now(), type: 'session:started', payload: {} },
    ]);

    const received: number[] = [];
    const unsub = store.watch('sess-1', 3, (event) => {
      received.push(event.seq);
    });

    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'running' },
    });
    // seq 3 — should NOT be delivered (fromSeq=3 means only seq > 3)
    // Wait, fromSeq=3 but this is seq 3... let's check logic
    // The watch should deliver events with seq > fromSeq
    // seq 3 should NOT match > 3

    await store.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'completed' },
    });
    // seq 4 — SHOULD be delivered

    unsub();

    expect(received).toEqual([4]);
  });

  it('concurrent appends to same session are serialized', async () => {
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        store.append('sess-1', {
          time: now(),
          type: 'session:dag-event',
          payload: {
            event: {
              time: now(),
              type: 'task:started',
              taskId: `task-${i}`,
              message: `Task ${i} started`,
            },
          },
        }),
      );
    }

    const seqs = await Promise.all(promises);
    // Should be 1..10 in some order, but all unique
    expect(new Set(seqs).size).toBe(10);

    const events = await store.read('sess-1');
    expect(events).toHaveLength(10);
    // Seqs should be monotonically increasing in the file
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it('survives fresh instance after restart (seq continuity)', async () => {
    await store.appendBatch('sess-1', [
      createdEvent(),
      { time: now(), type: 'session:started', payload: {} },
    ]);

    // Create a second store instance — simulates server restart
    const store2 = new FileEventStore(tmpDir);
    const seq = await store2.append('sess-1', {
      time: now(),
      type: 'session:status-change',
      payload: { status: 'completed' },
    });

    expect(seq).toBe(3);

    const events = await store2.read('sess-1');
    expect(events).toHaveLength(3);
    expect(events[2].seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

describe('materializeSession', () => {
  it('returns null for empty events', () => {
    expect(materializeSession([])).toBeNull();
  });

  it('returns null when no created event', () => {
    const events = [
      { seq: 1, time: now(), type: 'session:started' as const, payload: {} },
    ];
    expect(materializeSession(events)).toBeNull();
  });

  it('materializes minimal session from created event', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      {
        seq: 1,
        time: t,
        type: 'session:created' as const,
        payload: { config },
      },
    ];

    const session = materializeSession(events);
    expect(session).not.toBeNull();
    expect(session!.config).toEqual(config);
    expect(session!.status).toBe('running');
    expect(session!.llmStatus.state).toBe('queued');
    expect(session!.events).toEqual([]);
    expect(session!.todos).toEqual([]);
    expect(session!.lastSeq).toBe(1);
  });

  it('materializes full session lifecycle', () => {
    const t = now();
    const config = makeConfig();
    const events = buildLifecycleEvents(t, config);
    const session = materializeSession(events)!;

    expect(session.status).toBe('completed');
    expect(session.llmStatus.state).toBe('completed');
    expect(session.error).toBeUndefined();
    expect(session.output).toEqual({ text: 'Done', planPath: '/plan.md' });
    expect(session.events).toHaveLength(1);
    expect(session.taskStatus['task']).toBe('task:completed');
    expect(session.lastSeq).toBe(8);
  });

  it('materializes failed session', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:started' as const, payload: { pid: 100 } },
      { seq: 3, time: t, type: 'session:error-change' as const, payload: { error: 'Boom' } },
      { seq: 4, time: t, type: 'session:status-change' as const, payload: { status: 'failed' as const } },
      {
        seq: 5,
        time: t,
        type: 'session:llm-status-change' as const,
        payload: { llmStatus: { state: 'failed' as const, label: 'Failed', updatedAt: t } },
      },
    ];

    const session = materializeSession(events)!;
    expect(session.status).toBe('failed');
    expect(session.error).toBe('Boom');
    expect(session.llmStatus.state).toBe('failed');
  });

  it('materializes agent graph', () => {
    const t = now();
    const config = makeConfig();
    const graph = [
      { id: 'n1', prompt: 'Do A', dependencies: [], status: 'pending' as const },
      { id: 'n2', prompt: 'Do B', dependencies: ['n1'], status: 'pending' as const },
    ];

    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:agent-graph-set' as const, payload: { graph } },
      { seq: 3, time: t, type: 'session:agent-graph-node-status' as const, payload: { nodeId: 'n1', status: 'running' as const } },
      { seq: 4, time: t, type: 'session:agent-graph-node-status' as const, payload: { nodeId: 'n1', status: 'completed' as const } },
    ];

    const session = materializeSession(events)!;
    expect(session.agentGraph).toHaveLength(2);
    expect(session.agentGraph[0].status).toBe('completed');
    expect(session.agentGraph[1].status).toBe('pending');
  });

  it('materializes chat thread', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      {
        seq: 2,
        time: t,
        type: 'session:chat-thread-created' as const,
        payload: { provider: 'openai', model: 'gpt-4', workspacePath: '/tmp', taskPrompt: 'Fix it' },
      },
      {
        seq: 3,
        time: t,
        type: 'session:chat-message' as const,
        payload: { message: { role: 'user' as const, content: 'Hello', time: t } },
      },
      {
        seq: 4,
        time: t,
        type: 'session:chat-message' as const,
        payload: { message: { role: 'assistant' as const, content: 'Hi!', time: t } },
      },
    ];

    const session = materializeSession(events)!;
    expect(session.chatThread).not.toBeUndefined();
    expect(session.chatThread!.messages).toHaveLength(2);
    expect(session.chatThread!.messages[0].content).toBe('Hello');
  });

  it('materializes todos', () => {
    const t = now();
    const config = makeConfig();
    const todo = { id: 't1', text: 'Do stuff', done: false, createdAt: t, updatedAt: t };
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:todo-item-added' as const, payload: { item: todo } },
      { seq: 3, time: t, type: 'session:todo-item-toggled' as const, payload: { itemId: 't1', done: true, status: 'done' as const } },
    ];

    const session = materializeSession(events)!;
    expect(session.todos).toHaveLength(1);
    expect(session.todos[0].done).toBe(true);
    expect(session.todos[0].status).toBe('done');
  });

  it('materializes todos-set replaces all todos', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      {
        seq: 2,
        time: t,
        type: 'session:todo-item-added' as const,
        payload: { item: { id: 't1', text: 'Old', done: false, createdAt: t, updatedAt: t } },
      },
      {
        seq: 3,
        time: t,
        type: 'session:todos-set' as const,
        payload: {
          items: [
            { id: 't2', text: 'New A', done: false, createdAt: t, updatedAt: t },
            { id: 't3', text: 'New B', done: true, createdAt: t, updatedAt: t },
          ],
        },
      },
    ];

    const session = materializeSession(events)!;
    expect(session.todos).toHaveLength(2);
    expect(session.todos[0].id).toBe('t2');
  });

  it('materializes todo-item-removed', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      {
        seq: 2,
        time: t,
        type: 'session:todo-item-added' as const,
        payload: { item: { id: 't1', text: 'A', done: false, createdAt: t, updatedAt: t } },
      },
      {
        seq: 3,
        time: t,
        type: 'session:todo-item-added' as const,
        payload: { item: { id: 't2', text: 'B', done: false, createdAt: t, updatedAt: t } },
      },
      { seq: 4, time: t, type: 'session:todo-item-removed' as const, payload: { itemId: 't1' } },
    ];

    const session = materializeSession(events)!;
    expect(session.todos).toHaveLength(1);
    expect(session.todos[0].id).toBe('t2');
  });

  it('materializes context facts (upsert by key)', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:context-fact' as const, payload: { fact: { key: 'arch', value: 'monorepo' } } },
      { seq: 3, time: t, type: 'session:context-fact' as const, payload: { fact: { key: 'arch', value: 'monorepo v2' } } },
      { seq: 4, time: t, type: 'session:context-fact' as const, payload: { fact: { key: 'lang', value: 'typescript' } } },
    ];

    const session = materializeSession(events)!;
    expect(session.contextFacts).toHaveLength(2);
    expect(session.contextFacts.find((f) => f.key === 'arch')!.value).toBe('monorepo v2');
  });

  it('materializes context compaction state', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      {
        seq: 2,
        time: t,
        type: 'session:context-compaction' as const,
        payload: { state: { turnsSinceLastCompaction: 5, previousCompressedHistory: 'summary...' } },
      },
    ];

    const session = materializeSession(events)!;
    expect(session.contextCompaction.turnsSinceLastCompaction).toBe(5);
    expect(session.contextCompaction.previousCompressedHistory).toBe('summary...');
  });

  it('materializes heartbeat', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:runner-heartbeat' as const, payload: { pid: 9999 } },
    ];

    const session = materializeSession(events)!;
    expect(session.lastHeartbeat).toBe(t);
  });

  it('stream-delta is a no-op for materialized state', () => {
    const t = now();
    const config = makeConfig();
    const events = [
      { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
      { seq: 2, time: t, type: 'session:stream-delta' as const, payload: { taskId: 'task', phase: 'planning' as const, delta: 'chunk' } },
    ];

    const session = materializeSession(events)!;
    // No assertion on delta — just verify it doesn't crash
    expect(session.lastSeq).toBe(2);
  });

  it('trims events beyond MAX_EVENTS (200)', () => {
    const t = now();
    const config = makeConfig();
    const events: SessionEvent[] = [
      { seq: 1, time: t, type: 'session:created', payload: { config } },
    ];
    for (let i = 2; i <= 210; i++) {
      events.push({
        seq: i,
        time: t,
        type: 'session:dag-event',
        payload: {
          event: { time: t, type: 'task:started', taskId: `t${i}`, message: `msg ${i}` },
        },
      });
    }

    const session = materializeSession(events)!;
    expect(session.events.length).toBeLessThanOrEqual(200);
  });
});

describe('applyEvent (incremental)', () => {
  it('updates lastSeq and updatedAt', () => {
    const t = now();
    const config = makeConfig();
    const session = materializeSession([
      { seq: 1, time: t, type: 'session:created', payload: { config } },
    ])!;

    const t2 = new Date(Date.now() + 1000).toISOString();
    applyEvent(session, {
      seq: 2,
      time: t2,
      type: 'session:status-change',
      payload: { status: 'completed' },
    });

    expect(session.lastSeq).toBe(2);
    expect(session.updatedAt).toBe(t2);
    expect(session.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLifecycleEvents(t: string, config: SessionConfig) {
  return [
    { seq: 1, time: t, type: 'session:created' as const, payload: { config } },
    { seq: 2, time: t, type: 'session:started' as const, payload: { pid: 100 } },
    {
      seq: 3,
      time: t,
      type: 'session:llm-status-change' as const,
      payload: { llmStatus: { state: 'implementing' as const, label: 'Implementing', updatedAt: t } },
    },
    {
      seq: 4,
      time: t,
      type: 'session:dag-event' as const,
      payload: {
        event: { time: t, type: 'task:completed', taskId: 'task', message: 'Task completed' },
      },
    },
    {
      seq: 5,
      time: t,
      type: 'session:task-status-change' as const,
      payload: { taskId: 'task', taskStatus: 'task:completed' },
    },
    {
      seq: 6,
      time: t,
      type: 'session:output-set' as const,
      payload: { output: { text: 'Done', planPath: '/plan.md' } },
    },
    {
      seq: 7,
      time: t,
      type: 'session:status-change' as const,
      payload: { status: 'completed' as const },
    },
    {
      seq: 8,
      time: t,
      type: 'session:llm-status-change' as const,
      payload: { llmStatus: { state: 'completed' as const, label: 'Completed', updatedAt: t } },
    },
  ];
}
