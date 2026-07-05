import * as vscode from "vscode";

/**
 * Workspace access layer (Phase 2.3). Thin, typed wrappers over the VS Code
 * API — the raw material Phase 3's tools (read_file, list_dir, …) and
 * Phase 5's indexer will consume. Keeping them here means the tool
 * implementations stay small and testable.
 */

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** List files in the workspace, respecting the default excludes. */
export async function listFiles(glob = "**/*", maxResults = 2000): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,dist,.git}/**", maxResults);
  const root = workspaceRoot();
  return uris
    .map((u) => (root ? vscode.workspace.asRelativePath(u) : u.fsPath))
    .sort();
}

export async function readFile(relativePath: string): Promise<string> {
  const root = workspaceRoot();
  if (!root) throw new Error("No workspace folder open");
  const uri = vscode.Uri.joinPath(root, relativePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder().decode(bytes);
}

export async function writeFile(relativePath: string, content: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) throw new Error("No workspace folder open");
  const uri = vscode.Uri.joinPath(root, relativePath);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

export interface ActiveFileInfo {
  /** Path relative to the workspace root. */
  path: string;
  languageId: string;
  content: string;
  /** The user's current selection, if any. */
  selection?: { text: string; startLine: number; endLine: number };
}

export function getActiveFile(): ActiveFileInfo | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return undefined;
  const doc = editor.document;
  const sel = editor.selection;
  return {
    path: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    content: doc.getText(),
    selection: sel.isEmpty
      ? undefined
      : {
          text: doc.getText(sel),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        },
  };
}
