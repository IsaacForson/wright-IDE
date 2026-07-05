import type { ModelClient } from "./client.js";
import type { ChatMessage, ToolCall, Usage } from "./types.js";
import type { Tool, ToolResult } from "./tools.js";
import { ContextBudget } from "./tokens.js";
import { ModelError } from "./errors.js";

/**
 * The ReAct-style agent loop (Phase 3.2): model responds with text and/or
 * tool calls; tools execute; results feed back; repeat until the model
 * stops calling tools or the iteration cap is hit.
 */

export interface AgentOptions {
  client: ModelClient;
  model: string;
  tools: Tool[];
  systemPrompt: string;
  /** Loop safety cap (Phase 3.3). */
  maxIterations?: number;
  budget?: ContextBudget;
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

  /** Run one user turn to completion, yielding events as they happen. */
  async *run(userText: string, runOpts: { signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
    const { client, model } = this.opts;
    const maxIterations = this.opts.maxIterations ?? 25;
    const totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finalText = "";

    this.messages.push({ role: "user", content: userText });

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      this.messages = this.budget.trimToFit(this.messages);

      const events = client.stream(
        {
          model,
          messages: this.messages,
          tools: [...this.tools.values()].map((t) => t.definition),
          max_tokens: 8_192,
        },
        { signal: runOpts.signal },
      );

      let turnText = "";
      let toolCalls: ToolCall[] = [];
      for await (const event of events) {
        if (event.type === "text") {
          turnText += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "reasoning") {
          yield { type: "reasoning", text: event.text };
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

      if (toolCalls.length === 0) {
        finalText = turnText;
        yield { type: "done", finalText, iterations: iteration, usage: totalUsage };
        return;
      }

      for (const call of toolCalls) {
        if (runOpts.signal?.aborted) throw new ModelError("aborted", "Agent run cancelled");
        const args = parseArgs(call.function.arguments);
        yield { type: "tool_start", id: call.id, name: call.function.name, args: args.ok ? args.value : { _raw: call.function.arguments } };
        const { result, approved } = await this.executeCall(call, args, runOpts.signal);
        yield { type: "tool_done", id: call.id, name: call.function.name, result, approved };
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.output || "(no output)",
        });
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
        result: { ok: false, output: `Invalid JSON in tool arguments: ${args.error}` },
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

function parseArgs(raw: string): ParsedArgs {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
