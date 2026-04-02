import type { Context, Tool } from '@mariozechner/pi-ai';
import type { SpawnAgentRequest } from '../types.js';

export function createContext(request: SpawnAgentRequest, prompt: string): Context {
  const tools = request.toolset?.tools as Tool[] | undefined;

  return {
    systemPrompt: request.systemPrompt,
    tools,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  };
}

export function normalizeModelEndpoint<TModel extends { provider?: string; baseUrl?: string }>(model: TModel): TModel {
  if (model.provider !== 'github-copilot') {
    return model;
  }

  const baseUrl = model.baseUrl ?? '';
  if (!baseUrl.includes('api.individual.githubcopilot.com')) {
    return model;
  }

  return {
    ...model,
    baseUrl: baseUrl.replace('api.individual.githubcopilot.com', 'api.githubcopilot.com'),
  };
}