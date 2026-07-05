import * as vscode from "vscode";

/**
 * Tab autocomplete (Phase 7): ghost-text completions via a LOCAL Ollama
 * FIM model. Deliberately never routed to NVIDIA — autocomplete is the
 * highest-volume caller and would burn through rate limits; a local model
 * gives ~200-900ms warm latency with zero cost.
 *
 * VS Code's InlineCompletionItemProvider supplies the ghost text + Tab-to-
 * accept UX; this provider supplies debounce, hard cancellation, caching,
 * and suffix-overlap trimming.
 */

const DEBOUNCE_MS = 250;
const PREFIX_CHARS = 2_000;
const SUFFIX_CHARS = 1_000;
const MAX_CACHE = 32;

interface OllamaConfig {
  url: string;
  model: string;
  enabled: boolean;
}

function getAutocompleteConfig(): OllamaConfig {
  const cfg = vscode.workspace.getConfiguration("wright.autocomplete");
  return {
    enabled: cfg.get<boolean>("enabled") ?? true,
    url: (cfg.get<string>("ollamaUrl") || "http://localhost:11434").replace(/\/$/, ""),
    model: cfg.get<string>("model") || "qwen2.5-coder:14b",
  };
}

export class WrightCompletionProvider implements vscode.InlineCompletionItemProvider {
  private cache = new Map<string, string>();
  private inflight: AbortController | undefined;
  /** After a failed health probe, stay silent until this timestamp. */
  private ollamaDownUntil = 0;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = getAutocompleteConfig();
    if (!config.enabled || Date.now() < this.ollamaDownUntil) return undefined;

    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    if (!prefix.trim()) return undefined;

    const cacheKey = `${document.uri.toString()}:${prefix.slice(-96)}:${suffix.slice(0, 32)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];

    // Debounce: every keystroke retriggers; only the pause survives.
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
    if (token.isCancellationRequested) return undefined;

    // Aggressive cancellation: a newer request kills the in-flight one.
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    token.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${config.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          prompt: prefix,
          suffix,
          stream: false,
          options: { num_predict: 64, temperature: 0.2, stop: ["\n\n\n"] },
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const body = (await res.json()) as { response?: string };
      let completion = body.response ?? "";

      completion = trimSuffixOverlap(completion, suffix);
      if (!completion.trim()) return undefined;

      this.cache.set(cacheKey, completion);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      // Ollama not running / model missing: back off for a minute, stay quiet.
      this.ollamaDownUntil = Date.now() + 60_000;
      return undefined;
    } finally {
      if (this.inflight === controller) this.inflight = undefined;
    }
  }
}

/** FIM models often re-emit the start of the suffix; drop the overlap. */
function trimSuffixOverlap(completion: string, suffix: string): string {
  const suffixHead = suffix.trimStart().slice(0, 40);
  if (!suffixHead) return completion;
  const idx = completion.indexOf(suffixHead);
  return idx > 0 ? completion.slice(0, idx) : completion;
}
