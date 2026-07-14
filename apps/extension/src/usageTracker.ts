import * as vscode from "vscode";

/**
 * Cross-provider usage tracking. Records tokens + request counts per provider
 * (and per model) — something a single-backend tool can't show. Persists to
 * globalState so all-time totals survive restarts; also keeps a per-day tally
 * that rolls over at midnight (local).
 */

export interface ProviderUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Per-model breakdown within this provider. */
  models: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
}

interface UsageStore {
  allTime: Record<string, ProviderUsage>;
  today: Record<string, ProviderUsage>;
  todayDate: string; // YYYY-MM-DD
}

const KEY = "wright.usage";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyProvider(): ProviderUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, models: {} };
}

export class UsageTracker {
  /** This-session-only tally (cleared each activation). */
  private session: Record<string, ProviderUsage> = {};
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  private load(): UsageStore {
    const store = this.memento.get<UsageStore>(KEY) ?? { allTime: {}, today: {}, todayDate: todayStr() };
    if (store.todayDate !== todayStr()) {
      store.today = {};
      store.todayDate = todayStr();
    }
    return store;
  }

  /** Record one served request (called from the failover client's usage hook). */
  record(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    const store = this.load();
    for (const bucket of [store.allTime, store.today, this.session]) {
      const p = (bucket[provider] ??= emptyProvider());
      p.requests += 1;
      p.inputTokens += inputTokens;
      p.outputTokens += outputTokens;
      const m = (p.models[model] ??= { requests: 0, inputTokens: 0, outputTokens: 0 });
      m.requests += 1;
      m.inputTokens += inputTokens;
      m.outputTokens += outputTokens;
    }
    void this.memento.update(KEY, store);
    this.emitter.fire();
  }

  snapshot(): { session: Record<string, ProviderUsage>; today: Record<string, ProviderUsage>; allTime: Record<string, ProviderUsage> } {
    const store = this.load();
    return { session: this.session, today: store.today, allTime: store.allTime };
  }

  reset(scope: "session" | "today" | "allTime"): void {
    if (scope === "session") {
      this.session = {};
    } else {
      const store = this.load();
      store[scope] = {};
      if (scope === "today") store.todayDate = todayStr();
      void this.memento.update(KEY, store);
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
