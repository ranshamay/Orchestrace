import type { Context, Tool } from '@mariozechner/pi-ai';
import type { LlmPromptInput, SpawnAgentRequest } from '../types.js';

export function createContext(request: SpawnAgentRequest, prompt: LlmPromptInput): Context {
  const tools = request.toolset?.tools as Tool[] | undefined;
  const content = toUserContent(prompt);

  return {
    systemPrompt: request.systemPrompt,
    tools,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };
}

function toUserContent(prompt: LlmPromptInput): string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (typeof prompt === 'string') {
    return prompt;
  }

  return prompt.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }

    return {
      type: 'image',
      data: part.data,
      mimeType: part.mimeType,
    };
  });
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