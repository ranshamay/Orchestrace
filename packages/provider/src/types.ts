/** Result from an LLM completion call. */
export interface LlmResult {
  text: string;
  filesChanged?: string[];
  usage?: { input: number; output: number; cost: number };
}

/** Options for an LLM completion request. */
export interface LlmRequest {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

/**
 * Abstraction over the LLM layer.
 * The default implementation uses pi-ai but this interface allows
 * swapping to any provider.
 */
export interface LlmAdapter {
  complete(request: LlmRequest): Promise<LlmResult>;
}
