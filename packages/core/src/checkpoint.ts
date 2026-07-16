import type { WorkspaceHost } from "./tools.js";

/**
 * Per-turn checkpoints (Cursor-style): a restore point is created at every
 * user turn. Each checkpoint lazily captures a file's content the moment
 * BEFORE the first write that follows the checkpoint's creation — so it
 * holds the exact workspace state as of that turn boundary. Restoring a
 * checkpoint rewinds every file it captured and drops all later checkpoints.
 *
 * State lives in memory for the session (like Cursor's), keyed off the
 * TrackedHost's onBeforeWrite hook.
 */

export interface Checkpoint {
  id: string;
  /** Short label — usually the start of the user message. */
  label: string;
  createdAt: number;
  /** Index into the transcript this checkpoint sits before. */
  messageIndex: number;
}

interface HostWithBeforeWrite extends WorkspaceHost {
  onBeforeWrite?: (path: string) => Promise<void>;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  /** Per checkpoint: path → content before first post-checkpoint write (null = didn't exist). */
  private snaps = new Map<string, Map<string, string | null>>();
  private seq = 0;
  /** While restoring, our own rewrites must not be captured into checkpoints. */
  private restoring = false;

  constructor(private readonly host: HostWithBeforeWrite) {
    // Every write first notifies us so open checkpoints can capture state.
    const prev = host.onBeforeWrite;
    host.onBeforeWrite = async (path) => {
      await prev?.(path);
      await this.capture(path);
    };
  }

  /** Open a new restore point for a user turn. */
  create(label: string, messageIndex: number): Checkpoint {
    const cp: Checkpoint = {
      id: `cp${++this.seq}`,
      label: label.replace(/\s+/g, " ").trim().slice(0, 80) || "checkpoint",
      createdAt: Date.now(),
      messageIndex,
    };
    this.checkpoints.push(cp);
    this.snaps.set(cp.id, new Map());
    return cp;
  }

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  get count(): number {
    return this.checkpoints.length;
  }

  reset(): void {
    this.checkpoints = [];
    this.snaps.clear();
  }

  /** Capture current on-disk content into any checkpoint that lacks this path. */
  private async capture(path: string): Promise<void> {
    if (this.restoring) return;
    const needed = this.checkpoints.filter((cp) => !this.snaps.get(cp.id)!.has(path));
    if (needed.length === 0) return;
    let current: string | null;
    try {
      current = await this.host.readFile(path);
    } catch {
      current = null; // didn't exist at this boundary
    }
    for (const cp of needed) this.snaps.get(cp.id)!.set(path, current);
  }

  /**
   * Rewind the workspace to the given checkpoint and drop it + everything
   * after. Returns the messageIndex to truncate the transcript to.
   */
  async restore(id: string): Promise<number | undefined> {
    const idx = this.checkpoints.findIndex((cp) => cp.id === id);
    if (idx === -1) return undefined;
    const target = this.checkpoints[idx]!;
    const files = this.snaps.get(id)!;
    this.restoring = true;
    try {
      for (const [path, content] of files) {
        if (content === null) {
          if (this.host.deleteFile) await this.host.deleteFile(path).catch(() => {});
          else await this.host.writeFile(path, "");
        } else {
          await this.host.writeFile(path, content);
        }
      }
    } finally {
      this.restoring = false;
    }
    // Drop this checkpoint and all later ones.
    for (const cp of this.checkpoints.slice(idx)) this.snaps.delete(cp.id);
    this.checkpoints = this.checkpoints.slice(0, idx);
    return target.messageIndex;
  }
}
