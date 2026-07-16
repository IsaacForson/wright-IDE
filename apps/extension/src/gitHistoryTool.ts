import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "@wright/core";

const execFileP = promisify(execFile);

/**
 * git_history: read-only git archaeology so the agent can explain WHY code
 * looks the way it does — recent commits, blame for a line range, or the
 * full diff of a specific commit. Read-only; never mutates the repo.
 */
export function createGitHistoryTool(root: string): Tool {
  const git = (args: string[], maxBuffer = 2_000_000) =>
    execFileP("git", args, { cwd: root, maxBuffer }).then((r) => r.stdout).catch((e: Error) => `git error: ${e.message}`);

  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "git_history",
        description:
          "Inspect git history to understand why code exists or changed. Modes: " +
          "'log' (recent commits, optionally for a file), 'blame' (who/when/why for a file's lines), " +
          "'show' (full diff + message of one commit). Read-only.",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["log", "blame", "show"] },
            path: { type: "string", description: "File path (for log/blame)" },
            commit: { type: "string", description: "Commit hash (for show)" },
            startLine: { type: "integer", description: "Blame range start (1-based)" },
            endLine: { type: "integer", description: "Blame range end" },
            limit: { type: "integer", description: "Max commits for log (default 15)" },
          },
          required: ["mode"],
        },
      },
    },
    async execute(args) {
      const mode = args.mode as string;
      try {
        if (mode === "show") {
          const commit = String(args.commit ?? "HEAD");
          const out = await git(["show", "--stat", "-p", "--no-color", commit]);
          return { ok: true, output: out.slice(0, 25_000) };
        }
        if (mode === "blame") {
          const path = String(args.path ?? "");
          if (!path) return { ok: false, output: "blame needs a path" };
          const range: string[] = [];
          if (typeof args.startLine === "number" && typeof args.endLine === "number") {
            range.push("-L", `${args.startLine},${args.endLine}`);
          }
          // Porcelain-ish: show commit, author, date, and the line.
          const out = await git(["blame", "--date=short", "-w", ...range, "--", path]);
          return { ok: true, output: out.slice(0, 20_000) || `No blame for ${path}` };
        }
        // log (default)
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 15;
        const gitArgs = ["log", `-n${limit}`, "--no-color", "--date=short", "--pretty=format:%h %ad %an: %s"];
        if (typeof args.path === "string" && args.path) gitArgs.push("--follow", "--", args.path);
        const out = await git(gitArgs);
        return { ok: true, output: out.slice(0, 15_000) || "No commits found." };
      } catch (err) {
        return { ok: false, output: `git_history failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
