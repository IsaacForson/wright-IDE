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
    extra_content?: { google?: { thought_signature?: string } };
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
    ensureGeminiThoughtSignatures(message, this.provider);
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
    // Some models put chain-of-thought in an inline <think>…</think> block
    // instead of reasoning_content; split it out so callers see one shape.
    const thinkSplitter = new ThinkTagSplitter();

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
        for (const part of thinkSplitter.push(delta.content)) {
          if (part.kind === "reasoning") {
            reasoning += part.text;
            yield { type: "reasoning", text: part.text };
          } else {
            text += part.text;
            yield { type: "text", text: part.text };
          }
        }
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
            ...(tc.extra_content?.google?.thought_signature
              ? { extra_content: tc.extra_content }
              : {}),
          };
          toolCalls.set(tc.index, call);
          yield { type: "tool_call_start", index: tc.index, id: call.id, name: call.function.name };
          if (call.function.arguments) {
            yield { type: "tool_call_delta", index: tc.index, id: call.id, name: call.function.name, text: call.function.arguments };
          }
        } else {
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
            yield { type: "tool_call_delta", index: tc.index, id: existing.id, name: existing.function.name, text: tc.function.arguments };
          }
          // Signature usually arrives on the first frame; keep any later copy too.
          if (tc.extra_content?.google?.thought_signature) {
            existing.extra_content = tc.extra_content;
          }
        }
      }
    }

    for (const part of thinkSplitter.flush()) {
      if (part.kind === "reasoning") {
        reasoning += part.text;
        yield { type: "reasoning", text: part.text };
      } else {
        text += part.text;
        yield { type: "text", text: part.text };
      }
    }

    const assembled: AssistantMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.size > 0 && {
        tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
      }),
    };
    ensureGeminiThoughtSignatures(assembled, this.provider);
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

  /** Index into the key pool; persists so we stay on a working key. */
  private keyIndex = 0;

  private async fetch(path: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
    const url = `${this.provider.baseUrl}${path}`;
    const keys = this.provider.apiKeys?.length
      ? this.provider.apiKeys
      : this.provider.apiKey
        ? [this.provider.apiKey]
        : [undefined];

    const doFetch = (key: string | undefined, noRateLimitRetry: boolean) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.provider.defaultHeaders,
      };
      if (key) headers["Authorization"] = `Bearer ${key}`;
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
        { ...opts.retry, signal: opts.signal, noRateLimitRetry },
      );
    };

    // Single key: normal behavior. Multiple keys: on rate_limit/auth, rotate
    // to the next key immediately and try it, cycling through all of them.
    if (keys.length <= 1) return doFetch(keys[0], false);

    let lastErr: unknown;
    for (let tried = 0; tried < keys.length; tried++) {
      const key = keys[this.keyIndex % keys.length];
      try {
        return await doFetch(key, true);
      } catch (err) {
        lastErr = err;
        const kind = err instanceof ModelError ? err.kind : undefined;
        if ((kind === "rate_limit" || kind === "auth") && !opts.signal?.aborted) {
          this.keyIndex++; // advance for this loop and future calls
          this.provider.apiKeys && opts.retry?.onRetry?.(err as ModelError, tried + 1, 0);
          continue;
        }
        throw err;
      }
    }
    // Every key is rate-limited. If the caller can fail over to another
    // provider, throw; otherwise fall back to waiting on the current key.
    if (lastErr instanceof ModelError && lastErr.kind === "rate_limit" && !opts.retry?.noRateLimitRetry) {
      return doFetch(keys[this.keyIndex % keys.length], false);
    }
    throw lastErr;
  }
}

/**
 * Gemini 3+ requires thought_signature on the first tool_call when continuing
 * a tool loop. Preserve signatures from the API; if a proxy stripped them,
 * fall back to Google's documented skip token so the request isn't rejected.
 */
function ensureGeminiThoughtSignatures(message: AssistantMessage, provider: ProviderConfig): void {
  if (!/generativelanguage\.googleapis\.com/i.test(provider.baseUrl)) return;
  const calls = message.tool_calls;
  if (!calls?.length) return;
  const first = calls[0]!;
  if (!first.extra_content?.google?.thought_signature) {
    first.extra_content = {
      google: { thought_signature: "skip_thought_signature_validator" },
    };
  }
}

type ThinkPart = { kind: "text" | "reasoning"; text: string };

/**
 * Splits inline <think>…</think> chain-of-thought (emitted by some models
 * at the very start of a response) away from real content, tolerating tags
 * fragmented across stream chunks.
 */
class ThinkTagSplitter {
  private state: "undecided" | "in" | "out" = "undecided";
  private carry = "";

  push(chunk: string): ThinkPart[] {
    this.carry += chunk;
    const out: ThinkPart[] = [];
    while (true) {
      if (this.state === "undecided") {
        const lead = this.carry.trimStart();
        if (lead.length === 0) return out;
        if (lead.startsWith("<think>")) {
          this.state = "in";
          this.carry = lead.slice("<think>".length);
          continue;
        }
        // Could still be a partial "<think" prefix — wait for more bytes.
        if (lead.length < "<think>".length && "<think>".startsWith(lead)) return out;
        this.state = "out";
        continue;
      }
      if (this.state === "in") {
        const end = this.carry.indexOf("</think>");
        if (end === -1) {
          // Emit all but a tail that might be a fragmented closing tag.
          const safe = this.carry.length - "</think>".length;
          if (safe > 0) {
            out.push({ kind: "reasoning", text: this.carry.slice(0, safe) });
            this.carry = this.carry.slice(safe);
          }
          return out;
        }
        if (end > 0) out.push({ kind: "reasoning", text: this.carry.slice(0, end) });
        this.carry = this.carry.slice(end + "</think>".length).replace(/^\n+/, "");
        this.state = "out";
        continue;
      }
      if (this.carry) {
        out.push({ kind: "text", text: this.carry });
        this.carry = "";
      }
      return out;
    }
  }

  flush(): ThinkPart[] {
    const rest = this.carry;
    this.carry = "";
    if (!rest) return [];
    return [{ kind: this.state === "in" ? "reasoning" : "text", text: rest }];
  }
}
