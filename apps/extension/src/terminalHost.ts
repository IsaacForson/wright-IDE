import * as vscode from "vscode";
import type { CommandResult, DirEntry, RunCommandOptions, SearchMatch, WorkspaceHost } from "@wright/core";

/**
 * Wraps a WorkspaceHost so run_command can execute in a visible "Wright"
 * integrated terminal (shell-integration API) or in an invisible sandbox
 * (Node spawn via the inner host). Output is captured for the agent and
 * optionally streamed to the chat UI via onChunk.
 */

const SHELL_READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 180_000;
/** No new output for this long → assume a long-running/interactive process. */
const IDLE_TIMEOUT_MS = 12_000;
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])/g;
/** Output markers that mean "a server/watcher started and won't exit." */
const SERVER_READY_RE =
  /(localhost:\d+|127\.0\.0\.1:\d+|ready in \d|Local:\s+https?:|listening on|compiled successfully|watching for file changes|dev server running|server (?:started|running)|VITE v[\d.]+\s+ready|webpack compiled|Now listening|running at http)/i;

export type CommandRunTarget = "terminal" | "sandbox";

export class TerminalHost implements WorkspaceHost {
  private terminal: vscode.Terminal | undefined;
  /** Default run target for agent commands. */
  target: CommandRunTarget = "terminal";
  /** Live output callback (wired by ChatViewProvider). */
  onChunk?: (text: string) => void;
  /** Resolver that pushes the currently running command to the background. */
  private bgResolve: (() => void) | undefined;

  /**
   * "Run in background" from the UI: hand control back to the agent now,
   * leaving the process running in the terminal.
   */
  backgroundCurrent(): void {
    this.bgResolve?.();
  }

  constructor(
    private readonly inner: WorkspaceHost,
    private readonly cwd: string,
  ) {}

  /** Focus / create the Wright terminal without running a command. */
  async revealTerminal(): Promise<void> {
    const terminal = await this.getTerminal();
    terminal.show(true);
  }

  private async getTerminal(): Promise<vscode.Terminal> {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({ name: "Wright", cwd: this.cwd });
    }
    this.terminal.show(true);
    return this.terminal;
  }

  async runCommand(command: string, opts?: RunCommandOptions): Promise<CommandResult> {
    const signal = opts?.signal;
    const onChunk = opts?.onChunk ?? this.onChunk;
    const target = opts?.target ?? this.target;

    if (target === "sandbox") {
      return this.inner.runCommand(command, { signal, onChunk, background: opts?.background });
    }

    const terminal = await this.getTerminal();

    // Wait for shell integration; without it, fall back to sandbox — but say
    // so, since the user expects to SEE commands running in the terminal.
    const started = Date.now();
    while (!terminal.shellIntegration && Date.now() - started < SHELL_READY_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const shell = terminal.shellIntegration;
    if (!shell) {
      vscode.window.setStatusBarMessage(
        "Wright: terminal shell integration unavailable — running invisibly (check terminal.integrated.shellIntegration.enabled)",
        8_000,
      );
      return this.inner.runCommand(command, { signal, onChunk, background: opts?.background });
    }

    const execution = shell.executeCommand(command);
    let output = "";
    let exited = false;
    const done = new Promise<number | null>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          sub.dispose();
          exited = true;
          resolve(event.exitCode ?? null);
        }
      });
    });

    const onAbort = () => terminal.sendText("\u0003", false); // Ctrl+C
    signal?.addEventListener("abort", onAbort, { once: true });

    // Read chunks, but never block forever: a dev server or watcher never
    // exits, so we hand control back to the agent once the process prints a
    // "server ready" marker, goes idle, is aborted, or the user clicks
    // "Run in background" — leaving it running in the visible Wright terminal.
    const startWall = Date.now();
    // background:true = explicit long-running process → short boot window.
    const idleMs = opts?.background ? 3_000 : IDLE_TIMEOUT_MS;
    let backgrounded = false;
    let cancelled = false;
    const bgRequested = new Promise<"background">((resolve) => {
      this.bgResolve = () => resolve("background");
    });
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal?.aborted) resolve("aborted");
      else signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const iterator = execution.read()[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (Date.now() - startWall > COMMAND_TIMEOUT_MS) {
          backgrounded = !exited;
          break;
        }
        let idleHandle: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<"idle">((resolve) => {
          idleHandle = setTimeout(() => resolve("idle"), idleMs);
        });
        const step = await Promise.race([iterator.next(), idle, bgRequested, aborted]);
        if (idleHandle) clearTimeout(idleHandle);
        if (step === "aborted") {
          cancelled = true; // Ctrl+C already sent by onAbort; return NOW
          break;
        }
        if (step === "background") {
          backgrounded = !exited;
          break;
        }
        if (step === "idle") {
          backgrounded = !exited; // still running but quiet → move on
          break;
        }
        if (step.done) break; // command finished on its own
        const chunk = step.value;
        output += chunk;
        const cleanChunk = chunk.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (cleanChunk) onChunk?.(cleanChunk);
        if (!exited && SERVER_READY_RE.test(output)) {
          backgrounded = true; // server is up; don't wait for an exit that won't come
          break;
        }
        if (output.length > 400_000) break; // runaway output guard
      }
    } catch {
      // stream can throw if the terminal is disposed mid-run
    } finally {
      this.bgResolve = undefined;
    }

    signal?.removeEventListener("abort", onAbort);
    let clean = output.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (cancelled) {
      clean += "\n\n[Command cancelled by the user (Ctrl+C sent to the terminal).]";
      return { stdout: clean, stderr: "", exitCode: null };
    }
    if (backgrounded && !exited) {
      clean +=
        "\n\n[This process is still running in the Wright terminal (e.g. a dev server / watcher). It started successfully — continue with the next step; do NOT wait for it to exit. To stop it, cancel the turn or close the terminal.]";
      return { stdout: clean, stderr: "", exitCode: 0 };
    }
    const exitCode = exited ? await done : null;
    return { stdout: clean, stderr: "", exitCode };
  }

  // ── delegation ──
  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }
  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }
  listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path);
  }
  search(query: string, glob?: string): Promise<SearchMatch[]> {
    return this.inner.search(query, glob);
  }
  deleteFile(path: string): Promise<void> {
    if (!this.inner.deleteFile) throw new Error("host does not support deleteFile");
    return this.inner.deleteFile(path);
  }
}
