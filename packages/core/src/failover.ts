import { ModelClient, type RequestOptions } from "./client.js";
import { ModelError } from "./errors.js";
import type { ChatRequest, ChatResult, StreamEvent } from "./types.js";

/**
 * Provider failover: try the primary client (which itself rotates its key
 * pool); when it is fully rate-limited, fall through to free backup
 * providers (local Ollama, Groq, Gemini, …) with their own models.
 * Streaming only fails over before the first chunk arrives.
 */

export interface FailoverTarget {
  client: ModelClient;
  /** Model to use on this provider; undefined = keep the request's model. */
  model?: string;
  name: string;
}

/** Reports which target actually served a request, with its token usage. */
export type UsageReporter = (info: { provider: string; model: string; inputTokens: number; outputTokens: number }) => void;

export class FailoverModelClient extends ModelClient {
  constructor(
    private readonly targets: FailoverTarget[],
    private readonly onFailover?: (from: string, to: string) => void,
    private readonly onUsage?: UsageReporter,
  ) {
    super(targets[0]!.client.providerConfig);
  }

  private report(i: number, usage?: { prompt_tokens: number; completion_tokens: number }): void {
    if (!this.onUsage) return;
    const t = this.targets[i]!;
    this.onUsage({
      provider: t.name,
      model: t.model ?? "?",
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    });
  }

  private mapReq(req: ChatRequest, i: number): ChatRequest {
    const model = this.targets[i]!.model;
    return model ? { ...req, model } : req;
  }

  private failoverOpts(opts: RequestOptions, i: number): RequestOptions {
    // While more targets remain, rate limits should throw (not wait).
    const hasMore = i < this.targets.length - 1;
    return { ...opts, retry: { ...opts.retry, noRateLimitRetry: hasMore } };
  }

  override async complete(req: ChatRequest, opts: RequestOptions = {}): Promise<ChatResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.targets.length; i++) {
      try {
        const res = await this.targets[i]!.client.complete(this.mapReq(req, i), this.failoverOpts(opts, i));
        this.report(i, res.usage);
        return res;
      } catch (err) {
        lastErr = err;
        if (!this.shouldFailover(err, i, opts)) throw err;
      }
    }
    throw lastErr;
  }

  override async *stream(req: ChatRequest, opts: RequestOptions = {}): AsyncGenerator<StreamEvent> {
    let lastErr: unknown;
    for (let i = 0; i < this.targets.length; i++) {
      try {
        const iterator = this.targets[i]!.client.stream(this.mapReq(req, i), this.failoverOpts(opts, i));
        const first = await iterator.next(); // errors before any output can fail over
        if (first.done) return;
        yield first.value;
        for await (const ev of iterator) {
          if (ev.type === "done") this.report(i, ev.result.usage);
          yield ev;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (!this.shouldFailover(err, i, opts)) throw err;
      }
    }
    throw lastErr;
  }

  private shouldFailover(err: unknown, i: number, opts: RequestOptions): boolean {
    if (opts.signal?.aborted) return false;
    if (i >= this.targets.length - 1) return false;
    const kind = err instanceof ModelError ? err.kind : undefined;
    // Auth fails over when another provider remains (multi-provider free tiers).
    if (kind !== "rate_limit" && kind !== "server" && kind !== "network" && kind !== "auth") return false;
    this.onFailover?.(this.targets[i]!.name, this.targets[i + 1]!.name);
    return true;
  }
}
