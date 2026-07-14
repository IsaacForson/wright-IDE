import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Reusable Workflows (Windsurf-style): markdown recipes in .wright/workflows/
 * invoked as `/name` in the composer. Selecting one expands its instructions
 * into the task, with any trailing text passed as the workflow's argument.
 */

export interface WorkflowInfo {
  name: string; // filename without .md
  description: string; // first non-heading line
}

function dir(root: string): string {
  return path.join(root, ".wright", "workflows");
}

export async function listWorkflows(root: string): Promise<WorkflowInfo[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir(root))).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const infos: WorkflowInfo[] = [];
  for (const f of files.sort()) {
    let desc = "";
    try {
      const raw = await fs.readFile(path.join(dir(root), f), "utf8");
      // First non-empty line that isn't a markdown heading (the heading usually
      // just repeats the name); fall back to the heading text if that's all there is.
      const lines = raw.split("\n").map((l) => l.trim());
      desc =
        lines.find((l) => l.length > 0 && !l.startsWith("#")) ??
        lines.find((l) => l.length > 0)?.replace(/^#+\s*/, "") ??
        "";
    } catch {
      /* ignore */
    }
    infos.push({ name: f.replace(/\.md$/, ""), description: desc.slice(0, 80) });
  }
  return infos;
}

/**
 * If `text` starts with `/name`, expand it into a runnable instruction using
 * the workflow file's contents; trailing text becomes the workflow argument.
 * Returns the original text unchanged when there's no matching workflow.
 */
export async function expandWorkflow(root: string, text: string): Promise<string> {
  const m = text.match(/^\/([\w-]+)\b[ \t]*([\s\S]*)$/);
  if (!m) return text;
  const [, name, rest] = m;
  let recipe: string;
  try {
    recipe = await fs.readFile(path.join(dir(root), `${name}.md`), "utf8");
  } catch {
    return text; // not a workflow — leave as typed
  }
  const arg = (rest ?? "").trim();
  return `Follow this saved workflow ("${name}") step by step:\n\n${recipe.trim()}${arg ? `\n\nInput for this run: ${arg}` : ""}`;
}
