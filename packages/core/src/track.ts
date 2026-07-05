import type { CommandResult, DirEntry, SearchMatch, WorkspaceHost } from "./tools.js";

/**
 * Change tracking (Phase 4.3). Wraps a WorkspaceHost and snapshots each
 * file's original content before the first write, so every agent edit is
 * reviewable (diff original vs current) and revertible. Edits still land
 * on disk immediately — the agent's verification step (build/tests) must
 * see them — but nothing is irreversible until the user keeps it.
 */

export interface FileChange {
  path: string;
  kind: "edited" | "created";
}

export class TrackedHost implements WorkspaceHost {
  /** Original content per touched path; null = file did not exist. */
  private snapshots = new Map<string, string | null>();

  constructor(private readonly inner: WorkspaceHost) {}

  /** Files touched since the last reset, oldest first. */
  changes(): FileChange[] {
    return [...this.snapshots.entries()].map(([path, snapshot]) => ({
      path,
      kind: snapshot === null ? "created" : "edited",
    }));
  }

  /** Original content of a touched file (null = did not exist). */
  snapshot(path: string): string | null | undefined {
    return this.snapshots.get(path);
  }

  /** Accept a change: drop the snapshot, keeping what's on disk. */
  keep(path: string): void {
    this.snapshots.delete(path);
  }

  /** Move the baseline (used by per-hunk accept: the hunk joins the snapshot). */
  setSnapshot(path: string, content: string): void {
    if (this.snapshots.has(path)) this.snapshots.set(path, content);
  }

  keepAll(): void {
    this.snapshots.clear();
  }

  /** Restore a file to its pre-agent state. */
  async revert(path: string): Promise<void> {
    if (!this.snapshots.has(path)) return;
    const snapshot = this.snapshots.get(path)!;
    if (snapshot === null) {
      if (this.inner.deleteFile) await this.inner.deleteFile(path);
      else await this.inner.writeFile(path, "");
    } else {
      await this.inner.writeFile(path, snapshot);
    }
    this.snapshots.delete(path);
  }

  async revertAll(): Promise<void> {
    // Newest-first so a created-then-edited chain unwinds cleanly.
    for (const path of [...this.snapshots.keys()].reverse()) {
      await this.revert(path);
    }
  }

  // ── WorkspaceHost delegation ──────────────────────────────────────────

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.snapshots.has(path)) {
      let original: string | null;
      try {
        original = await this.inner.readFile(path);
      } catch {
        original = null; // new file
      }
      this.snapshots.set(path, original);
    }
    return this.inner.writeFile(path, content);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path);
  }

  search(query: string, glob?: string): Promise<SearchMatch[]> {
    return this.inner.search(query, glob);
  }

  runCommand(command: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.inner.runCommand(command, signal);
  }

  deleteFile(path: string): Promise<void> {
    if (!this.inner.deleteFile) throw new Error("host does not support deleteFile");
    return this.inner.deleteFile(path);
  }
}
