import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelClient } from "../client.js";
import { chunkFile, embeddingText } from "../rag/chunker.js";
import { VectorStore, type SerializedIndex } from "../rag/store.js";

const execFileP = promisify(execFile);

/**
 * Repo indexer (Phase 5.2/5.4). Walks the workspace (via `git ls-files`
 * when available — free .gitignore handling — else a filtered walk),
 * chunks each file, embeds changed ones in batches, and persists the
 * index to ~/.wright/index/<workspace-hash>.json so the CLI and the
 * extension share it and restarts are incremental.
 */

const EMBED_BATCH = 24;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 4_000;
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "json", "md", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "swift", "php", "sh", "zsh", "bash", "yaml", "yml",
  "toml", "css", "scss", "html", "vue", "svelte", "sql", "graphql", "proto", "txt",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage", "__pycache__", ".venv", "vendor"]);

export interface IndexProgress {
  phase: "scanning" | "embedding" | "done";
  processed: number;
  total: number;
  currentFile?: string;
}

export class Indexer {
  readonly store: VectorStore;
  private dirty = false;

  private constructor(
    private readonly client: ModelClient,
    private readonly embedModel: string,
    readonly root: string,
    store: VectorStore | undefined,
  ) {
    this.store = store ?? new VectorStore(embedModel);
  }

  static indexPath(root: string): string {
    const hash = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16);
    return path.join(os.homedir(), ".wright", "index", `${hash}.json`);
  }

  /** Load the on-disk index if present (and built with the same model). */
  static async load(client: ModelClient, embedModel: string, root: string): Promise<Indexer> {
    let store: VectorStore | undefined;
    try {
      const raw = await fs.readFile(Indexer.indexPath(root), "utf8");
      const data = JSON.parse(raw) as SerializedIndex;
      if (data.version === 1 && data.model === embedModel) store = VectorStore.deserialize(data);
    } catch {
      // no cache yet
    }
    return new Indexer(client, embedModel, root, store);
  }

  get isBuilt(): boolean {
    return this.store.chunkCount > 0;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const file = Indexer.indexPath(this.root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.store.serialize()), "utf8");
    this.dirty = false;
  }

  /** Full sync: (re)embed changed files, drop deleted ones. Incremental by content hash. */
  async sync(opts: { signal?: AbortSignal; onProgress?: (p: IndexProgress) => void } = {}): Promise<{ embedded: number; removed: number; total: number }> {
    const report = opts.onProgress ?? (() => {});
    report({ phase: "scanning", processed: 0, total: 0 });

    const files = await this.listFiles();
    const seen = new Set(files);
    let removed = 0;
    for (const stale of this.store.paths()) {
      if (!seen.has(stale)) {
        this.store.removeFile(stale);
        this.dirty = true;
        removed++;
      }
    }

    // Determine which files changed.
    const toEmbed: Array<{ rel: string; content: string; hash: string }> = [];
    for (const rel of files) {
      if (opts.signal?.aborted) throw new Error("indexing cancelled");
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      const hash = createHash("sha1").update(content).digest("hex");
      if (this.store.fileHash(rel) !== hash) toEmbed.push({ rel, content, hash });
    }

    let processed = 0;
    for (const file of toEmbed) {
      if (opts.signal?.aborted) throw new Error("indexing cancelled");
      report({ phase: "embedding", processed, total: toEmbed.length, currentFile: file.rel });
      await this.indexFile(file.rel, file.content, file.hash, opts.signal);
      processed++;
    }

    await this.save();
    report({ phase: "done", processed, total: toEmbed.length });
    return { embedded: processed, removed, total: this.store.fileCount };
  }

  /** Re-index a single file (used by the save-watcher). */
  async updateFile(rel: string): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(path.join(this.root, rel), "utf8");
    } catch {
      this.store.removeFile(rel);
      this.dirty = true;
      await this.save();
      return;
    }
    if (content.includes("\u0000")) return;
    const hash = createHash("sha1").update(content).digest("hex");
    if (this.store.fileHash(rel) === hash) return;
    await this.indexFile(rel, content, hash);
    await this.save();
  }

  private async indexFile(rel: string, content: string, hash: string, signal?: AbortSignal): Promise<void> {
    const chunks = chunkFile(rel, content);
    if (chunks.length === 0) {
      this.store.removeFile(rel);
      this.dirty = true;
      return;
    }
    const vectors: Array<number[] | null> = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH).map(embeddingText);
      vectors.push(...(await this.embedResilient(batch, signal)));
    }
    // Drop chunks the service refused (rare); keep the file indexed.
    const kept = chunks.filter((_, i) => vectors[i] !== null);
    const keptVectors = vectors.filter((v): v is number[] => v !== null);
    if (kept.length === 0) {
      this.store.removeFile(rel);
    } else {
      this.store.setFile(rel, hash, kept, keptVectors);
    }
    this.dirty = true;
  }

  /**
   * The embedding NIM sometimes 500s on specific multi-text batches even
   * when every text embeds fine alone. On failure, bisect the batch down
   * to single texts and skip only true poison inputs (null).
   */
  private async embedResilient(texts: string[], signal?: AbortSignal): Promise<Array<number[] | null>> {
    try {
      return await this.client.embed(texts, { model: this.embedModel, inputType: "passage", signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (texts.length === 1) return [null];
      const mid = Math.ceil(texts.length / 2);
      return [
        ...(await this.embedResilient(texts.slice(0, mid), signal)),
        ...(await this.embedResilient(texts.slice(mid), signal)),
      ];
    }
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.client.embed([query], { model: this.embedModel, inputType: "query", signal });
    return vector!;
  }

  /** Workspace-relative paths of indexable files. */
  private async listFiles(): Promise<string[]> {
    let all: string[];
    try {
      const { stdout } = await execFileP(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: this.root, maxBuffer: 16_000_000 },
      );
      all = stdout.split("\n").filter(Boolean);
    } catch {
      all = await this.walk(this.root, "");
    }

    const filtered: string[] = [];
    for (const rel of all) {
      if (filtered.length >= MAX_FILES) break;
      const ext = path.extname(rel).slice(1).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (rel.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
      try {
        const stat = await fs.stat(path.join(this.root, rel));
        if (stat.size > MAX_FILE_BYTES || !stat.isFile()) continue;
      } catch {
        continue;
      }
      filtered.push(rel);
    }
    return filtered;
  }

  private async walk(abs: string, rel: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await this.walk(path.join(abs, entry.name), childRel)));
      else out.push(childRel);
    }
    return out;
  }
}
