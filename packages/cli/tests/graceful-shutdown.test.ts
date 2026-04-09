import { describe, expect, it } from 'vitest';

/**
 * Tests for the graceful shutdown design contract.
 *
 * The actual HTTP process lifecycle is hard to unit-test, so these tests
 * validate the key behavioral contracts:
 *   1. Runner EPIPE resilience (stdout/stderr don't crash on broken pipe)
 *   2. Draining flag prevents new work while allowing in-flight to complete
 *   3. SSE shutdown event shape
 */

// ---------------------------------------------------------------------------
// 1. Runner EPIPE resilience contract
// ---------------------------------------------------------------------------

describe('Runner EPIPE resilience', () => {
  it('swallows EPIPE errors on writable streams', () => {
    // Simulate the EPIPE handler pattern used in runner.ts
    const errors: Error[] = [];
    const handler = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      errors.push(err);
    };

    // EPIPE should be swallowed
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) as NodeJS.ErrnoException;
    handler(epipe);
    expect(errors).toHaveLength(0);

    // ERR_STREAM_DESTROYED should be swallowed
    const destroyed = Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' }) as NodeJS.ErrnoException;
    handler(destroyed);
    expect(errors).toHaveLength(0);

    // Other errors should propagate
    const other = Object.assign(new Error('EACCES'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    handler(other);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// 2. Draining guard contract
// ---------------------------------------------------------------------------

describe('Draining guard', () => {
  it('rejects new work when draining is true', () => {
    let draining = false;
    const isDraining = () => draining;

    // Simulate request handling
    const responses: Array<{ status: number; body: unknown }> = [];
    function handleStart(sendJson: (status: number, body: unknown) => void) {
      if (isDraining()) {
        sendJson(503, { error: 'Server is shutting down. Please retry after restart.' });
        return false;
      }
      return true;
    }

    // Before draining: request proceeds
    expect(handleStart((status, body) => responses.push({ status, body }))).toBe(true);
    expect(responses).toHaveLength(0);

    // During draining: request rejected with 503
    draining = true;
    expect(handleStart((status, body) => responses.push({ status, body }))).toBe(false);
    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(503);
    expect(responses[0].body).toEqual({ error: 'Server is shutting down. Please retry after restart.' });
  });
});

// ---------------------------------------------------------------------------
// 3. SSE shutdown event shape
// ---------------------------------------------------------------------------

describe('SSE shutdown event', () => {
  it('includes reason and timestamp', () => {
    const shutdownPayload = { reason: 'SIGTERM', time: new Date().toISOString() };

    expect(shutdownPayload).toHaveProperty('reason');
    expect(shutdownPayload).toHaveProperty('time');
    expect(shutdownPayload.reason).toBe('SIGTERM');
    expect(typeof shutdownPayload.time).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. Health endpoint contract
// ---------------------------------------------------------------------------

describe('Health endpoint contract', () => {
  it('returns draining status when shutting down', () => {
    const buildHealthResponse = (draining: boolean, sessions: Map<string, { status: string }>) => {
      const runningSessions = [...sessions.values()].filter((s) => s.status === 'running').length;
      return {
        statusCode: draining ? 503 : 200,
        body: {
          status: draining ? 'draining' : 'ok',
          sessions: { total: sessions.size, running: runningSessions },
        },
      };
    };

    const sessions = new Map<string, { status: string }>();
    sessions.set('s1', { status: 'running' });
    sessions.set('s2', { status: 'completed' });

    // Healthy
    const healthy = buildHealthResponse(false, sessions);
    expect(healthy.statusCode).toBe(200);
    expect(healthy.body.status).toBe('ok');
    expect(healthy.body.sessions.running).toBe(1);
    expect(healthy.body.sessions.total).toBe(2);

    // Draining
    const drain = buildHealthResponse(true, sessions);
    expect(drain.statusCode).toBe(503);
    expect(drain.body.status).toBe('draining');
    expect(drain.body.sessions.running).toBe(1);
  });
});
