import type { ServerResponse } from 'node:http';
import { now } from './clock.js';
import type { AgentTodoItem } from './types.js';

export function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function broadcastWorkStream(
  streams: Map<string, Set<ServerResponse>>,
  id: string,
  event: string,
  payload: unknown,
): void {
  const clients = streams.get(id);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const client of [...clients]) {
    try {
      sendSse(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }

  if (clients.size === 0) {
    streams.delete(id);
  }
}

export function closeWorkStream(streams: Map<string, Set<ServerResponse>>, id: string): void {
  const clients = streams.get(id);
  if (!clients) {
    return;
  }

  for (const client of clients) {
    try {
      client.end();
    } catch {
      // ignore close errors
    }
  }
  streams.delete(id);
}

export function broadcastSessionUpdate(
  streams: Map<string, Set<ServerResponse>>,
  id: string,
  session: Record<string, unknown>,
): void {
  broadcastWorkStream(streams, id, 'session-update', {
    id,
    session,
    time: now(),
  });
}

export function broadcastTodoUpdate(
  streams: Map<string, Set<ServerResponse>>,
  id: string,
  todos: AgentTodoItem[],
): void {
  broadcastWorkStream(streams, id, 'todo-update', {
    id,
    todos: todos.map((item) => ({ ...item })),
    time: now(),
  });
}