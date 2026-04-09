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

describe('PiAiAdapter retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.ORCHESTRACE_LLM_TRANSIENT_RETRIES;
    delete process.env.ORCHESTRACE_LLM_RETRY_BASE_DELAY_MS;
    delete process.env.ORCHESTRACE_LLM_RETRY_MAX_DELAY_MS;
    delete process.env.ORCHESTRACE_LLM_RETRY_JITTER_RATIO;
    delete process.env.ORCHESTRACE_LLM_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient timeout failures with exponential backoff before succeeding', async () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRIES = '2';
    process.env.ORCHESTRACE_LLM_RETRY_BASE_DELAY_MS = '5';
    process.env.ORCHESTRACE_LLM_RETRY_MAX_DELAY_MS = '100';
    process.env.ORCHESTRACE_LLM_RETRY_JITTER_RATIO = '0';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValueOnce(new Error('Request was aborted.'));
    executeMock.mockRejectedValueOnce(new Error('ETIMEDOUT upstream provider'));
    executeMock.mockResolvedValueOnce(makeAssistantTextResponse('Recovered after retries.') as never);

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    const completePromise = agent.complete('hello');
    await vi.advanceTimersByTimeAsync(20);
    const result = await completePromise;

    expect(result.text).toBe('Recovered after retries.');
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry prompt-too-large failures and fails fast', async () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRIES = '5';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValue(new Error('Maximum prompt length exceeded for this model context window.'));

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    await expect(agent.complete('hello')).rejects.toMatchObject({ failureType: 'prompt_too_large' });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('returns provider_unresponsive after exhausting transient retry budget', async () => {
    process.env.ORCHESTRACE_LLM_TRANSIENT_RETRIES = '1';
    process.env.ORCHESTRACE_LLM_RETRY_BASE_DELAY_MS = '1';
    process.env.ORCHESTRACE_LLM_RETRY_MAX_DELAY_MS = '10';
    process.env.ORCHESTRACE_LLM_RETRY_JITTER_RATIO = '0';

    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockRejectedValue(new Error('Request was aborted.'));

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    const completePromise = agent.complete('hello');
    const rejectionExpectation = expect(completePromise).rejects.toMatchObject({
      failureType: 'provider_unresponsive',
    });
    await vi.advanceTimersByTimeAsync(10);

    await rejectionExpectation;
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('uses increased default timeout when no override is provided', async () => {
    const executeMock = vi.mocked(executeWithOptionalTools);
    executeMock.mockResolvedValueOnce(makeAssistantTextResponse('ok') as never);

    const adapter = new PiAiAdapter();
    const agent = await adapter.spawnAgent({
      provider: 'github-copilot',
      model: 'gpt-5.3-codex',
      systemPrompt: 'system',
    });

    await agent.complete('hello');

    const firstCall = executeMock.mock.calls[0]?.[0] as { timeoutMs: number };
    expect(firstCall.timeoutMs).toBe(180_000);
  });
});