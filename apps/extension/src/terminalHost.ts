import * as vscode from "vscode";
import type { CommandResult, DirEntry, SearchMatch, WorkspaceHost } from "@wright/core";

/**
 * Wraps a WorkspaceHost so run_command executes in a visible "Wright"
 * integrated terminal (via the shell-integration API) — the user watches
 * commands live, exactly like Cursor. Output is still captured for the
 * agent. Falls back to the wrapped host's invisible runner when shell
 * integration isn't available.
 */

const SHELL_READY_TIMEOUT_MS = 4_000;
const COMMAND_TIMEOUT_MS = 180_000;
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])/g;

export class TerminalHost implements WorkspaceHost {
  private terminal: vscode.Terminal | undefined;

  constructor(
    private readonly inner: WorkspaceHost,
    private readonly cwd: string,
  ) {}

  private async getTerminal(): Promise<vscode.Terminal> {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({ name: "Wright", cwd: this.cwd });
    }
    this.terminal.show(true);
    return this.terminal;
  }

  async runCommand(command: string, signal?: AbortSignal): Promise<CommandResult> {
    const terminal = await this.getTerminal();

    // Wait briefly for shell integration; without it, fall back silently.
    const started = Date.now();
    while (!terminal.shellIntegration && Date.now() - started < SHELL_READY_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const shell = terminal.shellIntegration;
    if (!shell) return this.inner.runCommand(command, signal);

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
