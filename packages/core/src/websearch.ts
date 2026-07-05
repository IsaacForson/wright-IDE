import type { Tool } from "./tools.js";

/**
 * Web search tool (Phase 11). Pluggable backend, mirroring the model
 * provider abstraction: Tavily or Brave when an API key is configured
 * (real full-web results), otherwise the keyless DuckDuckGo instant-answer
 * API as a always-available — if limited — fallback. Reliable general web
 * search now requires a key; DDG HTML scraping is actively blocked.
 */

export type SearchProvider = "tavily" | "brave" | "duckduckgo";

export interface WebSearchConfig {
  provider?: SearchProvider;
  apiKey?: string;
  maxResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function createWebSearchTool(config: WebSearchConfig = {}): Tool {
  // Auto-select: a key implies its provider; no key → DuckDuckGo.
  const provider: SearchProvider = config.provider ?? (config.apiKey ? "tavily" : "duckduckgo");
  const maxResults = config.maxResults ?? 6;

  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web for current information, documentation, error messages, or anything outside the codebase. " +
          "Returns titles, URLs, and snippets. Use when the answer depends on up-to-date or external knowledge.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
          },
          required: ["query"],
        },
      },
    },
    async execute(args, signal) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { ok: false, output: 'missing required string parameter "query"' };
      try {
        const results = await runSearch(provider, query, config.apiKey, maxResults, signal);
        if (results.length === 0) {
          return {
            ok: true,
            output:
              provider === "duckduckgo"
                ? "No results. DuckDuckGo's keyless API only covers well-known topics — set a Tavily/Brave key for full web search."
                : "No results found.",
          };
        }
        const body = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        return { ok: true, output: body.slice(0, 12_000) };
      } catch (err) {
        return { ok: false, output: `web_search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

async function runSearch(
  provider: SearchProvider,
  query: string,
  apiKey: string | undefined,
  maxResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  switch (provider) {
    case "tavily":
      return searchTavily(query, apiKey, maxResults, signal);
    case "brave":
      return searchBrave(query, apiKey, maxResults, signal);
    case "duckduckgo":
      return searchDuckDuckGo(query, signal);
  }
}

async function searchTavily(query: string, apiKey: string | undefined, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!apiKey) throw new Error("Tavily requires an API key");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 300) }));
}

async function searchBrave(query: string, apiKey: string | undefined, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!apiKey) throw new Error("Brave requires an API key");
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.description ?? "").replace(/<[^>]*>/g, "").slice(0, 300) }));
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const res = await fetch(url, { signal, headers: { "User-Agent": "Wright/0.1" } });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  const results: SearchResult[] = [];
  if (data.AbstractText) {
    results.push({ title: data.Heading ?? query, url: data.AbstractURL ?? "", snippet: data.AbstractText });
  }
  const flat = (data.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t]));
  for (const t of flat) {
    if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text });
  }
  return results;
}
