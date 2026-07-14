import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { MemoryEntry, MemoryStore } from "@wright/core";

/**
 * File-backed project memory at <root>/.wright/memories.json — human-readable
 * and git-shareable so a whole team inherits the same learned context.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, ".wright", "memories.json");
  }

  async list(): Promise<MemoryEntry[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { memories?: MemoryEntry[] };
      return Array.isArray(parsed.memories) ? parsed.memories : [];
    } catch {
      return [];
    }
  }

  async add(text: string): Promise<MemoryEntry | undefined> {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const entries = await this.list();
    // Cheap dedupe: skip near-identical facts (normalized).
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (entries.some((e) => norm(e.text) === norm(trimmed))) return undefined;
    const entry: MemoryEntry = { id: `m${Date.now().toString(36)}${entries.length}`, text: trimmed, createdAt: Date.now() };
    // Newest last; cap to keep the prompt lean.
    const next = [...entries, entry].slice(-60);
    await this.save(next);
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((e) => e.id !== id));
  }

  async clear(): Promise<void> {
    await this.save([]);
  }

  private async save(entries: MemoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ memories: entries }, null, 2), "utf8");
  }
}
