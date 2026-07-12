import type { ModelClient } from "./client.js";
import type { ChatMessage, ToolCall, Usage } from "./types.js";
import type { Tool, ToolResult } from "./tools.js";
import { ContextBudget } from "./tokens.js";
import { ModelError } from "./errors.js";
import { sleep } from "./retry.js";

/**
 * The ReAct-style agent loop (Phase 3.2): model responds with text and/or
 * tool calls; tools execute; results feed back; repeat until the model
 * stops calling tools or the iteration cap is hit.
 */

/** Default pause between tool results and the next model call (smooths RPM spikes). */
export const DEFAULT_STEP_THROTTLE_MS = 500;

export interface AgentOptions {
  client: ModelClient;
  model: string;
  tools: Tool[];
  systemPrompt: string;
  /** Loop safety cap (Phase 3.3). */
  maxIterations?: number;
  budget?: ContextBudget;
  /**
   * Mandatory delay after tools run, before the next autonomous model call.
   * Defaults to 500ms. Set 0 to disable (tests).
   */
  stepThrottleMs?: number;
  /**
   * Approval gate: called before EVERY tool call. The host decides (via an
   * ApprovalPolicy + UI prompt) whether to allow. Return false to skip
   * execution (the model is told the user declined). Omit to allow all.
   */
  approve?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Raw tool-argument JSON streaming in — lets UIs show code being written live. */
  | { type: "tool_args_delta"; id: string; name: string; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_done"; id: string; name: string; result: ToolResult; approved: boolean }
  | { type: "done"; finalText: string; iterations: number; usage: Usage };

export class Agent {
  private messages: ChatMessage[];
  private readonly tools: Map<string, Tool>;
  private readonly budget: ContextBudget;

  constructor(private readonly opts: AgentOptions) {
    this.messages = [{ role: "system", content: opts.systemPrompt }];
    this.tools = new Map(opts.tools.map((t) => [t.definition.function.name, t]));
    this.budget = opts.budget ?? new ContextBudget({ contextWindow: 64_000, outputReserve: 8_192 });
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  reset(): void {
    this.messages = this.messages.slice(0, 1);
  }

  /** Restore a persisted conversation (Phase 10). Keeps the current system prompt. */
  restoreHistory(messages: ChatMessage[]): void {
    this.messages = [this.messages[0]!, ...messages.filter((m) => m.role !== "system")];
  }

  /**
   * Run one user turn to completion, yielding events as they happen.
   * Pass `images` (data: URIs) to send a multimodal message — requires a
   * vision-capable model.
   */
  async *run(
    userText: string,
    runOpts: { signal?: AbortSignal; images?: string[] } = {},
  ): AsyncGenerator<AgentEvent> {
    const { client, model } = this.opts;
    const maxIterations = this.opts.maxIterations ?? 25;
    const totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finalText = "";

    if (runOpts.images && runOpts.images.length > 0) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          ...runOpts.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      });
    } else {
      this.messages.push({ role: "user", content: userText });
    }

    // NVIDIA's gateway stalls when streaming a response to image input, so
    // once a turn carries images we run it non-streamed for its lifetime.
    const hasImages = this.messages.some(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      this.messages = this.budget.trimToFit(this.messages);
      const request = {
        model,
        messages: this.messages,
        tools: [...this.tools.values()].map((t) => t.definition),
        max_tokens: 8_192,
      };

      let turnText = "";
      let toolCalls: ToolCall[] = [];

      if (hasImages) {
        const result = await client.complete(request, { signal: runOpts.signal });
        turnText = result.message.content ?? "";
        if (turnText) yield { type: "text", text: turnText };
        if (result.usage) {
          totalUsage.prompt_tokens += result.usage.prompt_tokens;
          totalUsage.completion_tokens += result.usage.completion_tokens;
          totalUsage.total_tokens += result.usage.total_tokens;
        }
        this.messages.push(result.message);
        toolCalls = result.message.tool_calls ?? [];
      } else {
        for await (const event of client.stream(request, { signal: runOpts.signal })) {
          if (event.type === "text") {
            turnText += event.text;
            yield { type: "text", text: event.text };
          } else if (event.type === "reasoning") {
            yield { type: "reasoning", text: event.text };
          } else if (event.type === "tool_call_delta") {
            yield { type: "tool_args_delta", id: event.id, name: event.name, text: event.text };
          } else if (event.type === "done") {
            if (event.result.usage) {
              totalUsage.prompt_tokens += event.result.usage.prompt_tokens;
              totalUsage.completion_tokens += event.result.usage.completion_tokens;
              totalUsage.total_tokens += event.result.usage.total_tokens;
            }
            this.messages.push(event.result.message);
            toolCalls = event.result.message.tool_calls ?? [];
          }
        }
      }

      if (toolCalls.length === 0) {
        finalText = turnText;
        yield { type: "done", finalText, iterations: iteration, usage: totalUsage };
        return;
      }

      for (const call of toolCalls) {
        if (runOpts.signal?.aborted) throw new ModelError("aborted", "Agent run cancelled");
        // Models (esp. Mistral) sometimes emit "list_dirнодорож" — map to a known tool.
        const resolved = resolveToolName(call.function.name, this.tools.keys());
        if (resolved && resolved !== call.function.name) {
          call.function.name = resolved;
        }
        const rawArgs = call.function.arguments;
        const args = parseArgs(rawArgs);
        // Providers re-validate prior tool_call JSON on the next turn. Repair
        // (or neutralize) arguments in-place so a messy model emit can't 400 the loop.
        if (args.ok) {
          call.function.arguments = JSON.stringify(args.value);
        } else {
          call.function.arguments = "{}";
        }
        yield {
          type: "tool_start",
          id: call.id,
          name: call.function.name,
          args: args.ok ? args.value : { _raw: rawArgs },
        };
        const { result, approved } = await this.executeCall(call, args, runOpts.signal);
        yield { type: "tool_done", id: call.id, name: call.function.name, result, approved };
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.output || "(no output)",
        });
      }

      // Step-throttle: pause before the next model call so N tool rounds
      // don't burst the provider's RPM ceiling (e.g. free-tier 40 RPM).
      const throttleMs = this.opts.stepThrottleMs ?? DEFAULT_STEP_THROTTLE_MS;
      if (throttleMs > 0) {
        await sleep(throttleMs, runOpts.signal);
      }
    }

    // Iteration cap hit — tell the model's side of the conversation why it stopped.
    const capNote = `[Agent stopped: reached the maximum of ${maxIterations} iterations for this turn.]`;
    this.messages.push({ role: "assistant", content: capNote });
    yield { type: "done", finalText: finalText || capNote, iterations: maxIterations, usage: totalUsage };
  }

  private async executeCall(
    call: ToolCall,
    args: ParsedArgs,
    signal?: AbortSignal,
  ): Promise<{ result: ToolResult; approved: boolean }> {
    if (!args.ok) {
      return {
        approved: true,
        result: {
          ok: false,
          output:
            `Invalid JSON in tool arguments: ${args.error}. ` +
            `Call the tool again with ONE JSON object only (no trailing text, no second object, no markdown fences).`,
        },
      };
    }

    const tool = this.tools.get(call.function.name);
    if (!tool) {
      return {
        approved: true,
        result: { ok: false, output: `Unknown tool "${call.function.name}". Available: ${[...this.tools.keys()].join(", ")}` },
      };
    }

    if (this.opts.approve) {
      const approved = await this.opts.approve(call.function.name, args.value);
      if (!approved) {
        return {
          approved: false,
          result: { ok: false, output: "The user declined to allow this tool call. Ask them how to proceed, or try a different approach." },
        };
      }
    }

    try {
      const result = await tool.execute(args.value, signal);
      return { approved: true, result };
    } catch (err) {
      if (err instanceof ModelError && err.kind === "aborted") throw err;
      return { approved: true, result: { ok: false, output: `Tool error: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }
}

type ParsedArgs = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Map a model-emitted tool name onto a registered tool when the model glued
 * junk onto a valid name (e.g. "list_dirнодорож" → "list_dir").
 */
export function resolveToolName(raw: string, known: Iterable<string>): string | undefined {
  const name = raw.trim();
  if (!name) return undefined;
  const tools = known instanceof Set ? known : new Set(known);
  if (tools.has(name)) return name;

  // Leading snake_case token — stops at Cyrillic/punctuation/spaces.
  const ascii = name.match(/^[a-z][a-z0-9_]*/i)?.[0];
  if (ascii && tools.has(ascii)) return ascii;

  let best: string | undefined;
  for (const k of tools) {
    if (!name.startsWith(k)) continue;
    const rest = name.slice(k.length);
    // Remainder must not look like more of a snake_case name (avoids
    // mapping "list_dir_foo" → "list_dir" when both could exist).
    if (rest && /^[a-z0-9_]/i.test(rest)) continue;
    if (!best || k.length > best.length) best = k;
  }
  return best;
}

/**
 * Parse tool-call argument JSON. Models often append a second object, trailing
 * prose, or markdown fences — extract the first complete value when possible.
 */
function parseArgs(raw: string): ParsedArgs {
  const cleaned = stripArgWrappers(raw);
  if (!cleaned) return { ok: true, value: {} };

  const direct = tryParseObject(cleaned);
  if (direct) return { ok: true, value: direct };

  const extracted = extractFirstJsonValue(cleaned);
  if (extracted) {
    const value = tryParseObject(extracted);
    if (value) return { ok: true, value };
  }

  // Double-encoded: "\"{...}\"" or '"{\"a\":1}"'
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    try {
      const inner = JSON.parse(cleaned);
      if (typeof inner === "string") {
        const nested = parseArgs(inner);
        if (nested.ok) return nested;
      } else if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return { ok: true, value: inner as Record<string, unknown> };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    JSON.parse(cleaned);
    return { ok: false, error: "Tool arguments must be a JSON object" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripArgWrappers(raw: string): string {
  let s = raw.trim();
  // ```json ... ``` or ``` ... ```
  const fence = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) s = fence[1]!.trim();
  return s;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** First complete `{...}` or `[...]` in `text`, respecting strings/escapes. */
function extractFirstJsonValue(text: string): string | undefined {
  const start = text.search(/[\{\[]/);
  if (start < 0) return undefined;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Exported for focused tests / debugging of tool-arg repair. */
export const _parseArgsForTest = parseArgs;
