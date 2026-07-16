/**
 * Tracks NVIDIA (and other) API-key rate-limit health so the UI can show
 * which keys are cooling down after a 429.
 */

export type KeyHealthState = "ok" | "limited";

export interface KeyHealthSnapshot {
  /** Stable id derived from the key (not the raw secret). */
  id: string;
  /** Masked label for UI, e.g. nvapi-…a1b2 */
  label: string;
  state: KeyHealthState;
  /** Epoch ms when the key is expected to be usable again. */
  limitedUntil?: number;
  /** Seconds remaining (computed at snapshot time). */
  remainingSec?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

function hashKey(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `k${(h >>> 0).toString(36)}`;
}

export function maskApiKey(key: string): string {
  const tip = key.slice(-4);
  if (key.length <= 10) return `••••${tip}`;
  return `${key.slice(0, 6)}…${tip}`;
}

class KeyHealthTracker {
  /** key hash → limitedUntil epoch ms */
  private readonly limited = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  /** Mark a key as rate-limited. Default cool-down is 60s (or Retry-After). */
  markLimited(key: string, retryAfterSec?: number): void {
    if (!key) return;
    const ms =
      retryAfterSec && retryAfterSec > 0
        ? Math.max(retryAfterSec * 1000, 5_000)
        : DEFAULT_COOLDOWN_MS;
    const until = Date.now() + ms;
    const id = hashKey(key);
    const prev = this.limited.get(id) ?? 0;
    // Keep the later recovery time if we get another 429 while cooling.
    this.limited.set(id, Math.max(prev, until));
    this.emit();
  }

  /** Clear expired entries and return UI snapshots for the given key list. */
  snapshotForKeys(keys: string[]): KeyHealthSnapshot[] {
    const now = Date.now();
    for (const [id, until] of this.limited) {
      if (until <= now) this.limited.delete(id);
    }
    return keys.filter(Boolean).map((key) => {
      const id = hashKey(key);
      const limitedUntil = this.limited.get(id);
      if (limitedUntil && limitedUntil > now) {
        return {
          id,
          label: maskApiKey(key),
          state: "limited" as const,
          limitedUntil,
          remainingSec: Math.max(1, Math.ceil((limitedUntil - now) / 1000)),
        };
      }
      return { id, label: maskApiKey(key), state: "ok" as const };
    });
  }

  /** Map of key-id → remainingSec for quick webview updates. */
  remainingById(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, until] of this.limited) {
      if (until <= now) this.limited.delete(id);
      else out[id] = Math.max(1, Math.ceil((until - now) / 1000));
    }
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

/** Process-wide tracker — all ModelClient instances report here. */
export const keyHealth = new KeyHealthTracker();

export function keyHealthId(key: string): string {
  return hashKey(key);
}
