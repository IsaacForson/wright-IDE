import * as vscode from "vscode";
import type { ModelClient } from "@wright/core";
import { Indexer } from "@wright/core/node";

/**
 * Owns the codebase index inside VS Code (Phase 5.4): loads the shared
 * on-disk index, keeps it fresh on save, and exposes explicit rebuilds.
 *
 * Save-time embeds are debounced so a burst of saves (format-on-save,
 * multi-file edits) collapses into one index pass instead of N RPM spikes.
 */

const SAVE_DEBOUNCE_MS = 1_500;

export class IndexService implements vscode.Disposable {
  private indexer: Indexer | undefined;
  private building = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingSaves = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly embedModel: string) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.queueSave(doc)),
    );
  }

  /** Load (and lazily build) the index. Returns undefined until usable. */
  async ensure(client: ModelClient, root: string): Promise<Indexer | undefined> {
    if (!this.indexer) {
      this.indexer = await Indexer.load(client, this.embedModel, root);
    }
    if (!this.indexer.isBuilt && !this.building) {
      // First build runs in the background with a progress notification;
      // the current turn proceeds without semantic search.
      void this.rebuild();
      return undefined;
    }
    return this.indexer.isBuilt ? this.indexer : undefined;
  }

  async rebuild(): Promise<void> {
    const indexer = this.indexer;
    if (!indexer || this.building) return;
    this.building = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Wright: indexing codebase" },
        async (progress) => {
          const result = await indexer.sync({
            onProgress: (p) => {
              if (p.phase === "embedding") {
                progress.report({ message: `${p.processed + 1}/${p.total} ${p.currentFile ?? ""}` });
              }
            },
          });
          if (result.embedded > 0) {
            vscode.window.setStatusBarMessage(
              `Wright: indexed ${result.total} files (${indexer.store.chunkCount} chunks)`,
              5_000,
            );
          }
        },
      );
    } catch (err) {
      vscode.window.showWarningMessage(`Wright indexing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.building = false;
    }
  }

  private queueSave(doc: vscode.TextDocument): void {
    if (!this.indexer || this.building || doc.uri.scheme !== "file") return;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    if (rel.startsWith("..") || rel === doc.uri.fsPath) return; // outside the workspace
    this.pendingSaves.add(rel);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSaves(), SAVE_DEBOUNCE_MS);
  }

  private async flushSaves(): Promise<void> {
    this.saveTimer = undefined;
    const indexer = this.indexer;
    if (!indexer || this.building || this.pendingSaves.size === 0) return;
    const files = [...this.pendingSaves];
    this.pendingSaves.clear();
    for (const rel of files) {
      try {
        await indexer.updateFile(rel);
      } catch {
        // save-time refresh is best-effort; the next full sync catches up
      }
    }
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const d of this.disposables) d.dispose();
  }
}
