import type { Tool } from "../tools.js";
import type { SearchHit, VectorStore } from "./store.js";

/**
 * The codebase_search tool (Phase 5.3). Semantic retrieval as a tool the
 * agent composes with its lexical `search` — agentic hybrid retrieval:
 * meaning-based lookup here, exact symbols via ripgrep, the model decides.
 */

export interface SemanticIndex {
  store: VectorStore;
  embedQuery(query: string, signal?: AbortSignal): Promise<number[]>;
}

const MAX_RESULT_CHARS = 12_000;

export function createCodebaseSearchTool(index: SemanticIndex): Tool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "codebase_search",
        description:
          "Semantic search over the indexed codebase — finds code by MEANING, not exact text. " +
          "Use for questions like 'where is retry logic handled' or 'how do we validate auth'. " +
          "For exact strings, symbol names, or regexes, use the search tool instead. " +
          "Returns the most relevant code chunks with file paths and line ranges.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language description of the code you're looking for" },
          },
          required: ["query"],
        },
      },
    },
    async execute(args, signal) {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query) return { ok: false, output: 'missing required string parameter "query"' };
      if (index.store.chunkCount === 0) {
        return { ok: false, output: "The codebase index is empty. Fall back to the search and read_file tools." };
      }
      const vector = await index.embedQuery(query, signal);
      const hits = index.store.search(vector, 8);
      return { ok: true, output: formatHits(hits) };
    },
  };
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No relevant code found.";
  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const header = `── ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} (relevance ${hit.score.toFixed(2)})`;
    const body = hit.chunk.text.length > 3_000 ? hit.chunk.text.slice(0, 3_000) + "\n…" : hit.chunk.text;
    const entry = `${header}\n${body}`;
    if (used + entry.length > MAX_RESULT_CHARS) break;
    parts.push(entry);
    used += entry.length;
  }
  return parts.join("\n\n");
}
