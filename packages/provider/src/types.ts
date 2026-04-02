/** Result from an LLM completion call. */
export interface LlmResult {
  text: string;
  filesChanged?: string[];
  usage?: { input: number; output: number; cost: number };
}

/** Model selection for spawning a dedicated agent instance. */
export interface AgentModelConfig {
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Options for an LLM completion request. */
export interface LlmRequest {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Explicit API key (e.g. from OAuth). If omitted, pi-ai reads env vars. */
  apiKey?: string;
}

/** Dedicated agent process bound to a specific model selection. */
export interface LlmAgent {
  complete(prompt: string, signal?: AbortSignal): Promise<LlmResult>;
}

/** Options for spawning a dedicated agent. */
export interface SpawnAgentRequest extends AgentModelConfig {
  systemPrompt: string;
  signal?: AbortSignal;
  /** Explicit API key (e.g. from OAuth). If omitted, pi-ai reads env vars. */
  apiKey?: string;
}

/**
 * Abstraction over the LLM layer.
 * The default implementation uses pi-ai but this interface allows
 * swapping to any provider.
 */
export interface LlmAdapter {
  spawnAgent(request: SpawnAgentRequest): Promise<LlmAgent>;
  complete(request: LlmRequest): Promise<LlmResult>;
}
