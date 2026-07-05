import { ModelError } from "./errors.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (err: ModelError, attempt: number, delayMs: number) => void;
  /** When true, rate_limit errors are thrown immediately instead of retried
   *  (lets a caller rotate to a different API key rather than wait). */
  noRateLimitRetry?: boolean;
}

/**
 * Retry with exponential backoff + jitter on retryable errors (429/5xx/network).
 * Honors Retry-After when the provider sends one. Never retries auth or
 * bad-request errors, and never retries after the caller aborts.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 750;
  const maxDelayMs = opts.maxDelayMs ?? 45_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const modelErr = err instanceof ModelError ? err : undefined;
      if (opts.noRateLimitRetry && modelErr?.kind === "rate_limit") throw err;
      const canRetry = modelErr?.retryable && attempt < maxAttempts && !opts.signal?.aborted;
      if (!canRetry) throw err;

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      let delayMs = backoff * (0.5 + Math.random() * 0.5);
      if (modelErr.retryAfter) {
        delayMs = modelErr.retryAfter * 1000;
      } else if (modelErr.kind === "rate_limit") {
        // Rate windows are usually per-minute; without a Retry-After hint,
        // short exponential backoff just burns attempts. Wait meaningfully.
        delayMs = Math.max(delayMs, 5_000 * attempt);
      }
      opts.onRetry?.(modelErr, attempt, delayMs);
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelError("aborted", "Cancelled while waiting to retry"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
