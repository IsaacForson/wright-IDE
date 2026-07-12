import * as vscode from "vscode";
import type { CommandResult, DirEntry, RunCommandOptions, SearchMatch, WorkspaceHost } from "@wright/core";

/**
 * Wraps a WorkspaceHost so run_command can execute in a visible "Wright"
 * integrated terminal (shell-integration API) or in an invisible sandbox
 * (Node spawn via the inner host). Output is captured for the agent and
 * optionally streamed to the chat UI via onChunk.
 */

const SHELL_READY_TIMEOUT_MS = 4_000;
const COMMAND_TIMEOUT_MS = 180_000;
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])/g;

export type CommandRunTarget = "terminal" | "sandbox";

export class TerminalHost implements WorkspaceHost {
  private terminal: vscode.Terminal | undefined;
  /** Default run target for agent commands. */
  target: CommandRunTarget = "terminal";
  /** Live output callback (wired by ChatViewProvider). */
  onChunk?: (text: string) => void;

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
      return this.inner.runCommand(command, { signal, onChunk });
    }

    const terminal = await this.getTerminal();

    // Wait briefly for shell integration; without it, fall back to sandbox.
    const started = Date.now();
    while (!terminal.shellIntegration && Date.now() - started < SHELL_READY_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const shell = terminal.shellIntegration;
    if (!shell) return this.inner.runCommand(command, { signal, onChunk });

    const execution = shell.executeCommand(command);
    let output = "";
    const done = new Promise<number | null>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          sub.dispose();
          resolve(event.exitCode ?? null);
        }
      });
    });

    const onAbort = () => terminal.sendText("\u0003", false); // Ctrl+C
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const chunk of execution.read()) {
        output += chunk;
        const cleanChunk = chunk.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (cleanChunk) onChunk?.(cleanChunk);
        if (output.length > 400_000) break; // runaway output guard
      }
    } catch {
      // stream can throw if the terminal is disposed mid-run
    }

    const exitCode = await Promise.race([
      done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS)),
    ]);
    signal?.removeEventListener("abort", onAbort);

    const clean = output.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
