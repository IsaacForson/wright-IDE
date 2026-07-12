import type { ToolDefinition } from "./types.js";
import { applyEdit } from "./edit.js";

/**
 * The tool layer (Phase 3.1). Composition over enumeration: six composable
 * primitives, not fifty specialized tools. Filesystem/shell access goes
 * through the WorkspaceHost interface so core stays runtime-agnostic —
 * the CLI and the VS Code extension inject their own host.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Options for WorkspaceHost.runCommand. */
export interface RunCommandOptions {
  signal?: AbortSignal;
  /** Live stdout/stderr chunks for the UI. */
  onChunk?: (text: string) => void;
  /**
   * Where to run the command:
   * - terminal — visible IDE terminal (extension)
   * - sandbox — invisible local process (Node spawn)
   */
  target?: "terminal" | "sandbox";
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface WorkspaceHost {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  search(query: string, glob?: string): Promise<SearchMatch[]>;
  runCommand(command: string, opts?: RunCommandOptions): Promise<CommandResult>;
  /** Optional; used by change tracking to revert created files. */
  deleteFile?(path: string): Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Tool {
  definition: ToolDefinition;
  /** Tools that mutate state outside the loop's control need user approval. */
  requiresApproval: boolean;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

const MAX_OUTPUT_CHARS = 30_000;

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} of ${text.length} chars]`;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing required string parameter "${key}"`);
  return v;
}

function withLineNumbers(content: string, startLine = 1): string {
  return content
    .split("\n")
    .map((line, i) => `${String(startLine + i).padStart(5)}→${line}`)
    .join("\n");
}

export function createBuiltinTools(host: WorkspaceHost): Tool[] {
  const readFile: Tool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file from the workspace. Returns contents with line numbers. " +
          "Optionally pass offset (1-based start line) and limit (max lines) for large files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root" },
            offset: { type: "integer", description: "1-based line to start from" },
            limit: { type: "integer", description: "Maximum number of lines to return" },
          },
          required: ["path"],
        },
      },
    },
    async execute(args) {
      const content = await host.readFile(str(args, "path"));
      const lines = content.split("\n");
      const offset = typeof args.offset === "number" && args.offset > 1 ? Math.floor(args.offset) : 1;
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const header =
        offset > 1 || slice.length < lines.length
          ? `[showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]\n`
          : "";
      return { ok: true, output: truncate(header + withLineNumbers(slice.join("\n"), offset)) };
    },
  };

  const writeFile: Tool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create a new file or fully overwrite an existing one. " +
          "For targeted changes to existing files, prefer edit_file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root" },
            content: { type: "string", description: "Complete file contents" },
          },
          required: ["path", "content"],
        },
      },
    },
    async execute(args) {
      const path = str(args, "path");
      const content = typeof args.content === "string" ? args.content : "";
      await host.writeFile(path, content);
      return { ok: true, output: `Wrote ${content.length} chars to ${path}` };
    },
  };

  const editFile: Tool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Make a targeted edit to a file by exact search/replace. old_string must match the file " +
          "content exactly (copy it from read_file output WITHOUT the line-number prefix) and must be " +
          "unique in the file — include surrounding lines for uniqueness. Set replace_all to change " +
          "every occurrence.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root" },
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Replacement text" },
            replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    async execute(args) {
      const path = str(args, "path");
      const content = await host.readFile(path);
      const outcome = applyEdit(content, str(args, "old_string"), args.new_string as string ?? "", {
        replaceAll: args.replace_all === true,
      });
      if (!outcome.ok) return { ok: false, output: `edit_file failed: ${outcome.error}` };
      await host.writeFile(path, outcome.content);
      return { ok: true, output: `Applied ${outcome.matches} edit(s) to ${path}` };
    },
  };

  const listDir: Tool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and directories at a path. Directories end with /.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root; use \".\" for the root" },
          },
          required: ["path"],
        },
      },
    },
    async execute(args) {
      const entries = await host.listDir(str(args, "path"));
      if (entries.length === 0) return { ok: true, output: "(empty directory)" };
      const listing = entries
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
        .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
        .join("\n");
      return { ok: true, output: truncate(listing) };
    },
  };

  const search: Tool = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "search",
        description:
          "Search file contents across the workspace (like grep). Returns matching lines as path:line:text. " +
          "Use this to find symbols, strings, or patterns before reading files.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text or regex to search for" },
            glob: { type: "string", description: "Optional file glob filter, e.g. \"*.ts\"" },
          },
          required: ["query"],
        },
      },
    },
    async execute(args) {
      const matches = await host.search(str(args, "query"), typeof args.glob === "string" ? args.glob : undefined);
      if (matches.length === 0) return { ok: true, output: "No matches found." };
      const body = matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n");
      return { ok: true, output: truncate(`${matches.length} match(es):\n${body}`) };
    },
  };

  const runCommand: Tool = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command in the workspace root (build, test, install, git status, …). " +
          "Returns stdout, stderr and the exit code. " +
          "Always call this to execute commands yourself — never paste a command and ask the user to run it. " +
          "If permission is needed, the UI will ask; wait for approval and continue.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run" },
          },
          required: ["command"],
        },
      },
    },
    async execute(args, signal) {
      const result = await host.runCommand(str(args, "command"), { signal });
      const parts = [
        `exit code: ${result.exitCode}`,
        result.stdout.trim() && `stdout:\n${result.stdout.trim()}`,
        result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
      ].filter(Boolean);
      return { ok: result.exitCode === 0, output: truncate(parts.join("\n\n")) };
    },
  };

  return [readFile, editFile, writeFile, listDir, search, runCommand];
}
