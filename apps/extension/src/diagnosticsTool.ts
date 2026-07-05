import * as vscode from "vscode";
import type { Tool } from "@wright/core";

/**
 * get_diagnostics: expose the editor's Problems panel (TypeScript, ESLint,
 * any language server) to the agent — "fix the errors" without pasting them.
 */
export function createDiagnosticsTool(): Tool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "get_diagnostics",
        description:
          "Get current errors and warnings from the editor's language servers (TypeScript, ESLint, …) — " +
          "the Problems panel. Optionally filter to one file. Use this after editing to check for new " +
          "errors, or when asked to fix problems.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional workspace-relative file path to filter to" },
            severity: { type: "string", enum: ["error", "warning", "all"], description: "Default: all" },
          },
        },
      },
    },
    async execute(args) {
      const pathFilter = typeof args.path === "string" ? args.path : undefined;
      const sevFilter = args.severity === "error" ? 0 : args.severity === "warning" ? 1 : 99;
      const lines: string[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== "file") continue;
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (pathFilter && rel !== pathFilter && !rel.endsWith(pathFilter)) continue;
        for (const d of diags) {
          if (d.severity > sevFilter && sevFilter !== 99) continue;
          if (d.severity > vscode.DiagnosticSeverity.Warning) continue; // skip info/hint noise
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
          const source = d.source ? ` (${d.source}${d.code ? ` ${String(typeof d.code === "object" ? d.code.value : d.code)}` : ""})` : "";
          lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message.replace(/\s+/g, " ")}${source}`);
          if (lines.length >= 100) break;
        }
        if (lines.length >= 100) break;
      }
      if (lines.length === 0) return { ok: true, output: pathFilter ? `No problems in ${pathFilter}.` : "No problems reported." };
      return { ok: true, output: `${lines.length} problem(s):\n${lines.join("\n")}` };
    },
  };
}
