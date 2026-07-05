/**
 * Minimal Server-Sent Events parser for OpenAI-style streaming responses.
 * Yields the JSON payload of each `data:` line; stops at `data: [DONE]`.
 */

import { ModelError } from "./errors.js";

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
): AsyncGenerator<unknown> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      // Guard against a stream that hangs mid-response: if no bytes arrive
      // for idleTimeoutMs, abort with a timeout error rather than waiting forever.
      const timer = setTimeout(() => reader.cancel(new Error("idle timeout")), idleTimeoutMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (opts.signal?.aborted) throw new ModelError("aborted", "Request cancelled");
        throw new ModelError("timeout", "Stream stalled (no data received)", { cause: err });
      } finally {
        clearTimeout(timer);
      }

      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data === "") continue;

        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed keep-alive or partial frames rather than dying.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
