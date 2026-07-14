import type { Tool } from "./tools.js";

/**
 * Auto-learned project memory (Windsurf/Cursor "Memories"). The agent saves
 * durable, project-level facts as it learns them via the `remember` tool;
 * those facts are injected into the system prompt on every later turn, so
 * Wright stops needing the warm-up explanation each session.
 */

export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: number;
}

export interface MemoryStore {
  list(): Promise<MemoryEntry[]>;
  add(text: string): Promise<MemoryEntry | undefined>;
  remove(id: string): Promise<void>;
}

/** Render current memories for injection into the system prompt. */
export function memoriesBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((m) => `- ${m.text}`).join("\n");
  return `\n\n# Project memory (things you've learned about this project — assume these are true)\n${lines}`;
}

export function createRememberTool(store: MemoryStore): Tool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Save a durable, project-level fact for future sessions — a convention, architecture decision, " +
          "the tech stack, a recurring gotcha, or a stated user preference. Use ONLY for things that stay true " +
          "across tasks; never for transient details. One concise fact per call. These are recalled automatically later.",
        parameters: {
          type: "object",
          properties: {
            fact: { type: "string", description: "One concise, durable fact (e.g. 'Uses pnpm workspaces; core has zero VS Code imports')." },
          },
          required: ["fact"],
        },
      },
    },
    async execute(args) {
      const fact = typeof args.fact === "string" ? args.fact.trim() : "";
      if (!fact) return { ok: false, output: 'missing required string parameter "fact"' };
      const saved = await store.add(fact);
      return { ok: true, output: saved ? `Remembered: ${fact}` : "Already known — not duplicated." };
    },
  };
}
