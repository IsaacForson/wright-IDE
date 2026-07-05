import type { ChatMessage } from "./types.js";

/**
 * Token accounting (Phase 1.3). A cheap character-based estimate — accurate
 * enough for budgeting with a safety margin, no tokenizer dependency, works
 * for any model. Swap in a real tokenizer per-model later if budgets get tight.
 */

const CHARS_PER_TOKEN = 3.6; // conservative for code-heavy text
const PER_MESSAGE_OVERHEAD = 6; // role/framing tokens per message

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let count = PER_MESSAGE_OVERHEAD;
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      // Flat per-image cost — a vision tile is ~hundreds of tokens regardless.
      count += part.type === "text" ? estimateTokens(part.text) : 800;
    }
  } else {
    count += estimateTokens((msg.content as string) ?? "");
  }
  if (msg.role === "assistant" && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      count += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 8;
    }
  }
  return count;
}

export function estimateConversationTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export interface BudgetConfig {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Tokens reserved for the model's output. */
  outputReserve: number;
  /** Fraction of remaining input space allowed for retrieved context (RAG). */
  retrievalShare?: number;
}

/**
 * Decides how the context window is divided between the system prompt,
 * conversation history, retrieved context, and the model's output.
 */
export class ContextBudget {
  constructor(private readonly config: BudgetConfig) {}

  /** Total input tokens available after reserving output space. */
  get inputBudget(): number {
    return this.config.contextWindow - this.config.outputReserve;
  }

  /** Tokens available for retrieved context, given what's already committed. */
  retrievalBudget(committedTokens: number): number {
    const remaining = Math.max(0, this.inputBudget - committedTokens);
    return Math.floor(remaining * (this.config.retrievalShare ?? 0.5));
  }

  fits(messages: ChatMessage[]): boolean {
    return estimateConversationTokens(messages) <= this.inputBudget;
  }

  /**
   * Trim oldest non-system messages until the conversation fits.
   * Keeps the system prompt and the most recent turns.
   */
  trimToFit(messages: ChatMessage[]): ChatMessage[] {
    if (this.fits(messages)) return messages;
    const system = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    while (rest.length > 1 && !this.fits([...system, ...rest])) {
      rest.shift();
      // Never leave an orphaned tool result at the head — its parent
      // assistant tool_call message is gone, which some providers reject.
      while (rest[0]?.role === "tool") rest.shift();
    }
    return [...system, ...rest];
  }
}
