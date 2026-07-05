/**
 * Wire-format types. These deliberately mirror the OpenAI chat completions
 * schema so messages round-trip to any OpenAI-compatible provider (NVIDIA NIM,
 * Ollama, LM Studio, OpenAI itself) without translation.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, exactly as the model emitted them. */
    arguments: string;
  };
}

/** JSON Schema the model sees for a tool. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

/** A fully assembled (non-streaming or post-stream) completion result. */
export interface ChatResult {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage?: Usage;
  /** Chain-of-thought text, if the model emits reasoning_content. */
  reasoning?: string;
}

/** Events emitted while streaming a completion. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "done"; result: ChatResult };
