import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { CommandResult, DirEntry, SearchMatch, WorkspaceHost } from "../tools.js";

/**
 * Node implementation of WorkspaceHost, shared by the CLI and the VS Code
 * extension host. All paths are confined to the workspace root — an escape
 * attempt (.. or absolute paths outside the root) is an error, not a request.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage", "__pycache__", ".venv"]);
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCHABLE_FILE_BYTES = 1_000_000;

export class NodeWorkspaceHost implements WorkspaceHost {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(relative: string): string {
    const abs = path.resolve(this.root, relative);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes the workspace root: ${relative}`);
    }
    return abs;
  }

  async readFile(relative: string): Promise<string> {
    return fs.readFile(this.resolve(relative), "utf8");
  }

  async writeFile(relative: string, content: string): Promise<void> {
    const abs = this.resolve(relative);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async deleteFile(relative: string): Promise<void> {
    await fs.rm(this.resolve(relative), { force: true });
  }

  async listDir(relative: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.resolve(relative), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
  }

  async search(query: string, glob?: string): Promise<SearchMatch[]> {
    try {
      return await this.searchWithRipgrep(query, glob);
    } catch {
      return this.searchNaive(query, glob);
    }
  }

  private searchWithRipgrep(query: string, glob?: string): Promise<SearchMatch[]> {
    const args = ["--no-heading", "--line-number", "--color", "never", "--max-count", "50", "-e", query];
    if (glob) args.push("--glob", glob);
    args.push(".");
    return new Promise((resolve, reject) => {
      const proc = spawn("rg", args, { cwd: this.root });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => (out += d));
      proc.stderr.on("data", (d: Buffer) => (err += d));
      proc.on("error", reject); // rg not installed
      proc.on("close", (code) => {
        if (code !== 0 && code !== 1) return reject(new Error(err || `rg exited ${code}`)); // 1 = no matches
        const matches: SearchMatch[] = [];
        for (const line of out.split("\n")) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          const m = line.match(/^(.+?):(\d+):(.*)$/);
          if (m) matches.push({ path: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), text: m[3]!.slice(0, 400) });
        }
        resolve(matches);
      });
    });
  }

  /** Fallback when ripgrep isn't installed: recursive substring/regex scan. */
  private async searchNaive(query: string, glob?: string): Promise<SearchMatch[]> {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(query, "i");
    } catch {
      // not a valid regex — fall back to substring matching
    }
    const globRe = glob ? globToRegExp(glob) : undefined;
    const matches: SearchMatch[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(abs);
          continue;
        }
        const rel = path.relative(this.root, abs);
        if (globRe && !globRe.test(entry.name) && !globRe.test(rel)) continue;
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCHABLE_FILE_BYTES) continue;
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue; // binary
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
          const line = lines[i]!;
          const hit = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
          if (hit) matches.push({ path: rel, line: i + 1, text: line.slice(0, 400) });
        }
      }
    };

    await walk(this.root);
    return matches;
  }

  runCommand(command: string, signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, { cwd: this.root, shell: true });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        stderr += `\n[command timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was killed]`;
        proc.kill("SIGKILL");
      }, COMMAND_TIMEOUT_MS);

      const onAbort = () => proc.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });

      proc.stdout.on("data", (d: Buffer) => (stdout += d));
      proc.stderr.on("data", (d: Buffer) => (stderr += d));
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$|(^|/)${escaped}$`);
}
