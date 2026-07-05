import type {
  AssistantMessage,
  ChatRequest,
  ChatResult,
  FinishReason,
  StreamEvent,
  ToolCall,
  Usage,
} from "./types.js";
import type { ProviderConfig } from "./provider.js";
import { ModelError, errorFromResponse } from "./errors.js";
import { parseSSE } from "./sse.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface RequestOptions {
  signal?: AbortSignal;
  /** Applied to the initial connection; streams themselves are not retried mid-flight. */
  retry?: RetryOptions;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: FinishReason }>;
  usage?: Usage;
}

/**
 * Provider-agnostic client for OpenAI-compatible chat completion endpoints.
 * Owns the HTTP + SSE plumbing; knows nothing about tools' semantics, the
 * agent loop, or any editor — those live in higher layers.
 */
export class ModelClient {
  constructor(private readonly provider: ProviderConfig) {}

  get providerConfig(): ProviderConfig {
    return this.provider;
  }

  /** List model ids available on this provider. */
  async listModels(opts: RequestOptions = {}): Promise<string[]> {
    const res = await this.fetch("/models", { method: "GET" }, opts);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id);
  }

  /**
   * Embed a batch of texts. inputType matters for asymmetric retrieval
   * models: index chunks as "passage", search strings as "query".
   */
  async embed(
    texts: string[],
    opts: { model: string; inputType: "query" | "passage" } & RequestOptions,
  ): Promise<number[][]> {
    const res = await this.fetch(
      "/embeddings",
      {
        method: "POST",
        body: JSON.stringify({
          model: opts.model,
          input: texts,
          input_type: opts.inputType,
          encoding_format: "float",
        }),
      },
      opts,
    );
    const body = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    if (!body.data || body.data.length !== texts.length) {
      throw new ModelError("server", `Embedding response has ${body.data?.length ?? 0} vectors for ${texts.length} inputs`);
    }
    return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  /** Non-streaming completion. Prefer stream() anywhere a user is watching. */
  async complete(req: ChatRequest, opts: RequestOptions = {}): Promise<ChatResult> {
    const res = await this.fetch(
      "/chat/completions",
      { method: "POST", body: JSON.stringify({ ...req, stream: false }) },
      opts,
    );
    const body = (await res.json()) as {
      choices?: Array<{
        message?: AssistantMessage & { reasoning_content?: string };
        finish_reason?: FinishReason;
      }>;
      usage?: Usage;
    };
    const choice = body.choices?.[0];
    if (!choice?.message) {
      throw new ModelError("server", "Provider returned no choices");
    }
    const { reasoning_content, ...message } = choice.message;
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: body.usage,
      reasoning: reasoning_content ?? undefined,
    };
  }

  /**
   * Streaming completion. Emits text/reasoning deltas as they arrive and a
   * final `done` event carrying the assembled message (including any tool
   * calls, whose arguments stream in fragments and are stitched together here).
   */
  async *stream(req: ChatRequest, opts: RequestOptions = {}): AsyncGenerator<StreamEvent> {
    const res = await this.fetch(
      "/chat/completions",
      // stream_options.include_usage makes OpenAI-compatible providers emit
      // a final usage chunk; without it streaming responses report no usage.
      { method: "POST", body: JSON.stringify({ ...req, stream: true, stream_options: { include_usage: true } }) },
      opts,
    );
    if (!res.body) throw new ModelError("server", "Provider returned no response body");

    let text = "";
    let reasoning = "";
    let finishReason: FinishReason = null;
    let usage: Usage | undefined;
    // Tool calls arrive as deltas keyed by index: first frame has id+name,
    // subsequent frames append argument fragments.
    const toolCalls = new Map<number, ToolCall>();

    for await (const raw of parseSSE(res.body, { signal: opts.signal })) {
      const chunk = raw as StreamChunk;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        yield { type: "reasoning", text: delta.reasoning_content };
      }
      if (delta.content) {
        text += delta.content;
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const existing = toolCalls.get(tc.index);
        if (!existing) {
          const call: ToolCall = {
            id: tc.id ?? `call_${tc.index}`,
            type: "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          };
          toolCalls.set(tc.index, call);
          yield { type: "tool_call_start", index: tc.index, id: call.id, name: call.function.name };
        } else {
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        }
      }
    }

    const assembled: AssistantMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.size > 0 && {
        tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
      }),
    };
    yield {
      type: "done",
      result: {
        message: assembled,
        finishReason,
        usage,
        reasoning: reasoning || undefined,
      },
    };
  }

  /** Convenience: run stream() to completion, collecting the final result. */
  async streamToResult(
    req: ChatRequest,
    opts: RequestOptions & { onEvent?: (e: StreamEvent) => void } = {},
  ): Promise<ChatResult> {
    for await (const event of this.stream(req, opts)) {
      opts.onEvent?.(event);
      if (event.type === "done") return event.result;
    }
    throw new ModelError("server", "Stream ended without a done event");
  }

  private async fetch(path: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
    const url = `${this.provider.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.provider.apiKey) headers["Authorization"] = `Bearer ${this.provider.apiKey}`;

    return withRetry(
      async () => {
        let res: Response;
        try {
          res = await fetch(url, { ...init, headers, signal: opts.signal });
        } catch (err) {
          if (opts.signal?.aborted) throw new ModelError("aborted", "Request cancelled");
          throw new ModelError("network", `Could not reach ${this.provider.name} at ${url}`, { cause: err });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw errorFromResponse(res.status, body, res.headers.get("retry-after"));
        }
        return res;
      },
      { ...opts.retry, signal: opts.signal },
    );
  }
}
