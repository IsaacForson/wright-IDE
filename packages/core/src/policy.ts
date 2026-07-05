/**
 * Approval policy (Phase 9). Decides, per tool call, whether to run
 * silently or ask the user first. Three modes:
 *
 *   manual     — every mutating tool asks; reads run silently
 *   auto-edit  — file edits run silently; shell commands ask
 *   auto       — everything runs silently…
 *
 * …EXCEPT: denylisted commands and writes to protected paths (credentials,
 * keys, .env) always ask, in every mode. Allowlisted commands run silently
 * in auto-edit and auto. The policy never hard-blocks — the user decides.
 */

export type ApprovalMode = "manual" | "auto-edit" | "auto";

export interface PolicyDecision {
  action: "allow" | "ask";
  /** Why we're asking — shown in the approval prompt. */
  reason?: string;
}

export interface PolicyConfig {
  mode: ApprovalMode;
  /** Command prefixes that run without asking (in auto-edit/auto). */
  allowCommands?: string[];
  /** Regexes (strings) that always ask, any mode. */
  denyCommands?: string[];
  /** Glob-ish patterns for files whose writes always ask. */
  protectedPaths?: string[];
}

export const DEFAULT_ALLOW_COMMANDS = [
  "ls", "cat", "pwd", "echo", "which", "node --check", "node --test",
  "npm test", "npm run", "npm ls", "pnpm test", "pnpm run", "pnpm typecheck", "pnpm build", "pnpm ls",
  "yarn test", "yarn run", "tsc", "npx tsc", "git status", "git diff", "git log", "git show", "git branch",
  "grep", "rg", "find", "wc", "head", "tail",
];

export const DEFAULT_DENY_COMMANDS = [
  "\\brm\\s+-[a-z]*r", // recursive delete
  "\\brm\\s+.*\\*", // wildcard delete
  "\\bsudo\\b",
  "\\bgit\\s+push\\b",
  "\\bgit\\s+reset\\s+--hard\\b",
  "\\bgit\\s+clean\\b",
  "\\bchmod\\s+777\\b",
  "curl[^|]*\\|\\s*(ba)?sh", // pipe-to-shell
  "wget[^|]*\\|\\s*(ba)?sh",
  "\\bmkfs\\b|\\bdd\\s+if=",
  ">\\s*/dev/",
];

export const DEFAULT_PROTECTED_PATHS = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*credentials*", "*secret*", ".git/*",
];

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

export class ApprovalPolicy {
  private readonly denyRes: RegExp[];
  private readonly protectedRes: RegExp[];

  constructor(private readonly config: PolicyConfig) {
    this.denyRes = (config.denyCommands ?? DEFAULT_DENY_COMMANDS).map((p) => new RegExp(p, "i"));
    this.protectedRes = (config.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map(globToRe);
  }

  get mode(): ApprovalMode {
    return this.config.mode;
  }

  decide(name: string, args: Record<string, unknown>): PolicyDecision {
    // Reads and searches are always silent.
    if (!MUTATING_TOOLS.has(name)) return { action: "allow" };

    if (name === "run_command") {
      const command = String(args.command ?? "");
      for (const re of this.denyRes) {
        if (re.test(command)) return { action: "ask", reason: "matches the deny list (potentially destructive)" };
      }
      if (this.config.mode === "manual") return { action: "ask", reason: "manual mode" };
      const allow = this.config.allowCommands ?? DEFAULT_ALLOW_COMMANDS;
      const trimmed = command.trim();
      if (allow.some((prefix) => trimmed === prefix || trimmed.startsWith(prefix + " "))) {
        return { action: "allow" };
      }
      return this.config.mode === "auto" ? { action: "allow" } : { action: "ask", reason: "shell command" };
    }

    // write_file / edit_file
    const path = String(args.path ?? "");
    const base = path.split("/").pop() ?? path;
    for (const re of this.protectedRes) {
      if (re.test(path) || re.test(base)) {
        return { action: "ask", reason: `writes to a protected path (${path})` };
      }
    }
    return this.config.mode === "manual" ? { action: "ask", reason: "manual mode" } : { action: "allow" };
  }
}

function globToRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
