import { afterEach, describe, expect, it, vi } from 'vitest';

function setupHookTest() {
  const setSessions = vi.fn();
  const setChatMessages = vi.fn();
  const setTodos = vi.fn();
  const setNodeTokenStreams = vi.fn();
  const setObserverState = vi.fn();

  let capturedCleanup: void | (() => void);

    const reactMock = {
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      capturedCleanup = effect();
    }),
    useRef: vi.fn(() => ({ current: '' })),
    useState: vi.fn((initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, vi.fn()]),
    useCallback: vi.fn((fn: unknown) => fn),
  };

  return {
    setSessions,
    setChatMessages,
    setTodos,
    setNodeTokenStreams,
    setObserverState,
    reactMock,
    getCleanup: () => capturedCleanup,
  };
}

describe('useChatStream reset behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('react');
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it('clears token streams and observer state when no session is selected', async () => {
    const ctx = setupHookTest();
    vi.doMock('react', () => ctx.reactMock);

    const { useChatStream } = await import('../src/app/hooks/useChatStream');

    const eventSourceCtor = vi.fn();
    (globalThis as { EventSource: unknown }).EventSource = eventSourceCtor;

    useChatStream({
      enabled: true,
      selectedSessionId: '',
      setSessions: ctx.setSessions,
      setChatMessages: ctx.setChatMessages,
      setTodos: ctx.setTodos,
      setNodeTokenStreams: ctx.setNodeTokenStreams,
      setObserverState: ctx.setObserverState,
    });

    expect(ctx.setNodeTokenStreams).toHaveBeenCalledWith({});
    expect(ctx.setObserverState).toHaveBeenCalledWith(null);
    expect(eventSourceCtor).not.toHaveBeenCalled();
  });

  it('clears token streams and observer state when stream is disabled', async () => {
    const ctx = setupHookTest();
    vi.doMock('react', () => ctx.reactMock);

    const { useChatStream } = await import('../src/app/hooks/useChatStream');

    const eventSourceCtor = vi.fn();
    (globalThis as { EventSource: unknown }).EventSource = eventSourceCtor;

    useChatStream({
      enabled: false,
      selectedSessionId: 'session-1',
      setSessions: ctx.setSessions,
      setChatMessages: ctx.setChatMessages,
      setTodos: ctx.setTodos,
      setNodeTokenStreams: ctx.setNodeTokenStreams,
      setObserverState: ctx.setObserverState,
    });

    expect(ctx.setNodeTokenStreams).toHaveBeenCalledWith({});
    expect(ctx.setObserverState).toHaveBeenCalledWith(null);
    expect(eventSourceCtor).not.toHaveBeenCalled();
  });

  it('closes EventSource and clears observer state on cleanup for active session stream', async () => {
    const ctx = setupHookTest();
    vi.doMock('react', () => ctx.reactMock);

    const { useChatStream } = await import('../src/app/hooks/useChatStream');

    const close = vi.fn();
    const addEventListener = vi.fn();
    const eventSourceCtor = vi.fn(() => ({ close, addEventListener }));
    (globalThis as { EventSource: unknown }).EventSource = eventSourceCtor;

    useChatStream({
      enabled: true,
      selectedSessionId: 'session-123',
      setSessions: ctx.setSessions,
      setChatMessages: ctx.setChatMessages,
      setTodos: ctx.setTodos,
      setNodeTokenStreams: ctx.setNodeTokenStreams,
      setObserverState: ctx.setObserverState,
    });

    expect(eventSourceCtor).toHaveBeenCalledWith(expect.stringContaining('/api/work/stream?id=session-123&v=2'));
    expect(addEventListener).toHaveBeenCalled();

    ctx.getCleanup()?.();

    expect(close).toHaveBeenCalledTimes(1);
    expect(ctx.setObserverState).toHaveBeenCalledWith(null);
  });
});