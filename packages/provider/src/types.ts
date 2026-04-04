export interface LlmResultMetadata {
  stopReason?: string;
  endpoint?: string;
}

/** Result from an LLM completion call. */
export interface LlmResult {
  text: string;
  filesChanged?: string[];
  usage?: { input: number; output: number; cost: number };
  metadata?: LlmResultMetadata;
}

export interface LlmTextPart {
  type: 'text';
  text: string;
}

export interface LlmImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

export type LlmPromptPart = LlmTextPart | LlmImagePart;
export type LlmPromptInput = string | LlmPromptPart[];

/** Tool execution telemetry emitted by the provider adapter. */
export interface LlmToolCallEvent {
  type: 'started' | 'result';
  toolCallId: string;
  toolName: string;
  arguments?: string;
  result?: string;
  isError?: boolean;
}

/** Tool definition exposed to the model during completion. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

/** Requested tool call produced by the model. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool execution result fed back to the model. */
export interface LlmToolResult {
  content: string;
  isError?: boolean;
  details?: unknown;
}

/** Runtime toolset contract used by the provider adapter. */
export interface LlmToolset {
  tools: LlmToolDefinition[];
  executeTool(call: LlmToolCall, signal?: AbortSignal): Promise<LlmToolResult>;
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
  prompt: LlmPromptInput;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUsage?: (usage: { input: number; output: number; cost: number }) => void;
  onToolCall?: (event: LlmToolCallEvent) => void;
  toolset?: LlmToolset;
  /** Explicit API key (e.g. from OAuth). If omitted, pi-ai reads env vars. */
  apiKey?: string;
}

/** Stream-time callbacks for incremental completion output and usage. */
export interface LlmCompletionOptions {
  onTextDelta?: (delta: string) => void;
  onUsage?: (usage: { input: number; output: number; cost: number }) => void;
  onToolCall?: (event: LlmToolCallEvent) => void;
}

/** Dedicated agent process bound to a specific model selection. */
export interface LlmAgent {
  complete(prompt: LlmPromptInput, signal?: AbortSignal, options?: LlmCompletionOptions): Promise<LlmResult>;
}

/** Options for spawning a dedicated agent. */
export interface SpawnAgentRequest extends AgentModelConfig {
  systemPrompt: string;
  signal?: AbortSignal;
  toolset?: LlmToolset;
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
