import type { ChatMessage, ToolResultMessage } from "./types.js";

/**
 * Token accounting (Phase 1.3). A cheap character-based estimate — accurate
 * enough for budgeting with a safety margin, no tokenizer dependency, works
 * for any model. Swap in a real tokenizer per-model later if budgets get tight.
 */

const CHARS_PER_TOKEN = 3.6; // conservative for code-heavy text
const PER_MESSAGE_OVERHEAD = 6; // role/framing tokens per message

/** Keep the last N tool results relatively full; older ones get stubbed first. */
const KEEP_RECENT_TOOLS = 6;
/** Soft cap for recent tool payloads during budget pressure. */
const RECENT_TOOL_CHARS = 6_000;
/** Stub size for older tool payloads — enough to know what ran, not the dump. */
const OLD_TOOL_CHARS = 500;
/** Aggressive stub when still over budget after soft compression. */
const AGGRESSIVE_TOOL_CHARS = 200;

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

  get contextWindow(): number {
    return this.config.contextWindow;
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
   * Fit conversation into the input budget without forgetting the task.
   *
   * Order of pressure relief:
   * 1. Compress old tool outputs (recent ones kept fuller)
   * 2. Drop middle turns while pinning the first user message (original goal)
   *    and the tail from the latest user message (current ask)
   * 3. Last resort: FIFO from the unprotected middle
   */
  trimToFit(messages: ChatMessage[]): ChatMessage[] {
    if (this.fits(messages)) return messages;

    const system = messages.filter((m) => m.role === "system");
    let rest = messages.filter((m) => m.role !== "system").map(cloneMessage);

    rest = compressToolResults(rest, RECENT_TOOL_CHARS, OLD_TOOL_CHARS);
    if (this.fits([...system, ...rest])) return [...system, ...rest];

    rest = compressToolResults(rest, OLD_TOOL_CHARS, AGGRESSIVE_TOOL_CHARS);
    if (this.fits([...system, ...rest])) return [...system, ...rest];

    const firstUser = rest.findIndex((m) => m.role === "user");
    let lastUser = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i]!.role === "user") {
        lastUser = i;
        break;
      }
    }

    if (firstUser >= 0 && lastUser > firstUser) {
      const head = rest[firstUser]!;
      const tail = rest.slice(lastUser);
      let middle = rest.slice(firstUser + 1, lastUser);

      while (middle.length > 0 && !this.fits([...system, head, ...middle, ...tail])) {
        middle.shift();
        while (middle[0]?.role === "tool") middle.shift();
      }

      let out = [head, ...middle, ...tail];
      if (this.fits([...system, ...out])) return [...system, ...out];

      // Still over: drop from middle of `out` but never the pinned head or last user+.
      const tailLen = tail.length;
      while (out.length > 1 + tailLen && !this.fits([...system, ...out])) {
        out.splice(1, 1);
        while (out.length > 1 + tailLen && out[1]?.role === "tool") out.splice(1, 1);
      }
      return [...system, ...out];
    }

    // Single-user / no-user fallback — classic FIFO after compression.
    while (rest.length > 1 && !this.fits([...system, ...rest])) {
      rest.shift();
      while (rest[0]?.role === "tool") rest.shift();
    }
    return [...system, ...rest];
  }
}

function cloneMessage(msg: ChatMessage): ChatMessage {
  if (msg.role === "tool") return { ...msg };
  if (msg.role === "assistant") {
    return {
      ...msg,
      tool_calls: msg.tool_calls?.map((tc) => ({
        ...tc,
        function: { ...tc.function },
        extra_content: tc.extra_content ? { ...tc.extra_content, google: tc.extra_content.google ? { ...tc.extra_content.google } : undefined } : undefined,
      })),
    };
  }
  if (msg.role === "user" && Array.isArray(msg.content)) {
    return { ...msg, content: msg.content.map((p) => ({ ...p })) };
  }
  return { ...msg };
}

/**
 * Shrink tool result bodies. The most recent KEEP_RECENT_TOOLS keep `recentMax`
 * chars; older ones are stubbed to `oldMax`.
 */
function compressToolResults(
  messages: ChatMessage[],
  recentMax: number,
  oldMax: number,
): ChatMessage[] {
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") toolIndexes.push(i);
  }
  const recent = new Set(toolIndexes.slice(-KEEP_RECENT_TOOLS));

  return messages.map((msg, i) => {
    if (msg.role !== "tool") return msg;
    const max = recent.has(i) ? recentMax : oldMax;
    return stubToolContent(msg, max);
  });
}

function stubToolContent(msg: ToolResultMessage, maxChars: number): ToolResultMessage {
  const content = msg.content ?? "";
  if (content.length <= maxChars) return msg;
  const kept = content.slice(0, maxChars);
  return {
    ...msg,
    content: `${kept}\n…[truncated ${content.length - maxChars} chars to preserve conversation context]`,
  };
}
