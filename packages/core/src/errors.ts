/**
 * Typed errors so callers can react by kind (retry on rate limit, surface
 * auth errors, trim context on overflow) instead of string-matching.
 */

export type ModelErrorKind =
  | "auth"
  | "rate_limit"
  | "context_length"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "aborted";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  /** Seconds to wait before retrying, when the provider says (Retry-After). */
  readonly retryAfter?: number;

  constructor(
    kind: ModelErrorKind,
    message: string,
    opts: { status?: number; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ModelError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }

  get retryable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout"
    );
  }
}

/** Map an HTTP error response to a typed ModelError. */
export function errorFromResponse(status: number, body: string, retryAfterHeader?: string | null): ModelError {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;
  const detail = body.slice(0, 500);

  if (status === 401 || status === 403) {
    return new ModelError("auth", `Authentication failed (${status}). Check NVIDIA_API_KEY. ${detail}`, { status });
  }
  if (status === 429) {
    return new ModelError("rate_limit", `Rate limited (429). ${detail}`, { status, retryAfter });
  }
  if (status === 400 && /context|token|length|maximum/i.test(body)) {
    return new ModelError("context_length", `Context window exceeded. ${detail}`, { status });
  }
  if (status >= 400 && status < 500) {
    return new ModelError("bad_request", `Request rejected (${status}). ${detail}`, { status });
  }
  return new ModelError("server", `Provider error (${status}). ${detail}`, { status });
}
