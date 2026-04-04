import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  });

  it('refreshes credentials once and retries once on auth failure', async () => {
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
    });

    const result = await agent.complete('hello');

    expect(result.text).toBe('Recovered after refresh.');
    expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(2);

    const firstCall = executeMock.mock.calls[0][0] as { options: Record<string, unknown> };
    const secondCall = executeMock.mock.calls[1][0] as { options: Record<string, unknown> };
    expect(firstCall.options.apiKey).toBe('stale-token');
    expect(secondCall.options.apiKey).toBe('fresh-token');
  });
});
