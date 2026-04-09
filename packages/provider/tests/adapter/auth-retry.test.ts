import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAiAdapter } from '../../src/adapter.js';
import { executeWithOptionalTools } from '../../src/adapter/tools.js';

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({
    provider: 'github-copilot',
    baseUrl: 'https://api.githubcopilot.com',
    reasoning: true,
  })),
}));

vi.mock('../../src/adapter/tools.js', () => ({
  executeWithOptionalTools: vi.fn(),
}));

function makeAssistantTextResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { totalTokens: 24 },
    timestamp: Date.now(),
  };
}

describe('PiAiAdapter auth refresh retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS = '1';
    process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS = '1';
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '1';
  });

  afterEach(() => {
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS;
    delete process.env.ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS;
    delete process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS;
  });

    it('fails fast by default on auth failure without attempting refresh', async () => {
    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValueOnce(new Error('401 IDE token expired: unauthorized: token expired'));

    const refreshApiKey = vi.fn(async () => 'fresh-token');

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
      apiKey: 'stale-token',
      refreshApiKey,
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({
      name: 'LlmFailureError',
      failureType: 'auth',
    });
    expect(refreshApiKey).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

      it('refreshes credentials once with forced refresh intent and retries once only when explicitly enabled', async () => {

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValueOnce(new Error('401 IDE token expired: unauthorized: token expired'));
    executeMock.mockResolvedValueOnce(makeAssistantTextResponse('Recovered after refresh.') as never);

    const refreshApiKey = vi.fn(async () => 'fresh-token');

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
      apiKey: 'stale-token',
      refreshApiKey,
      allowAuthRefreshRetry: true,
    });

    const result = await agent.complete('hello');

    expect(result.text).toBe('Recovered after refresh.');
        expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(refreshApiKey).toHaveBeenCalledWith({ forceRefresh: true });
    expect(executeMock).toHaveBeenCalledTimes(2);


    const firstCall = executeMock.mock.calls[0][0] as { options: Record<string, unknown> };
    const secondCall = executeMock.mock.calls[1][0] as { options: Record<string, unknown> };
    expect(firstCall.options.apiKey).toBe('stale-token');
    expect(secondCall.options.apiKey).toBe('fresh-token');
  });

  it('does not refresh more than once when retried auth request fails again', async () => {
    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValue(new Error('401 IDE token expired: unauthorized: token expired'));

    const refreshApiKey = vi.fn(async () => 'fresh-token');

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
      apiKey: 'stale-token',
      refreshApiKey,
      allowAuthRefreshRetry: true,
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({
      name: 'LlmFailureError',
      failureType: 'auth',
    });
        expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(refreshApiKey).toHaveBeenCalledWith({ forceRefresh: true });
    expect(executeMock).toHaveBeenCalledTimes(2);

  });

    it('adds actionable Copilot re-auth guidance for token-expired auth failures', async () => {
    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValueOnce(new Error('401 IDE token expired: unauthorized: token expired'));

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
      apiKey: 'stale-token',
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({
      name: 'LlmFailureError',
      failureType: 'auth',
      message: expect.stringContaining('Re-authenticate with `orchestrace auth github-copilot` and retry.'),
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('retries timeout once and succeeds without session-level replay pressure', async () => {


    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '1';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValueOnce(new Error('deadline exceeded by upstream'));
    executeMock.mockResolvedValueOnce(makeAssistantTextResponse('Recovered after transient timeout.') as never);

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    const result = await agent.complete('hello');

    expect(result.text).toBe('Recovered after transient timeout.');
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('fails after exhausting configured transient timeout retries', async () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '1';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValue(new Error('deadline exceeded by upstream'));

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({
      name: 'LlmFailureError',
      failureType: 'timeout',
    });
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable unknown request failures', async () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS = '3';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValue(new Error('tool schema mismatch: invalid argument shape'));

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({
      name: 'LlmFailureError',
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
