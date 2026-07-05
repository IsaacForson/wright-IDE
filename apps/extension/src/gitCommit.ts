import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ModelClient, nvidiaProvider } from "@wright/core";
import { getConfig } from "./config.js";
import { workspaceRoot } from "./workspace.js";

const execFileP = promisify(execFile);

/**
 * Git integration (Phase 11): generate a commit message from the staged
 * diff (fast model) and drop it into the Source Control input box.
 */
export async function generateCommitMessage(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const config = getConfig();
  if (!config.apiKey) {
    vscode.window.showWarningMessage("Wright: no NVIDIA API key configured.");
    return;
  }

  let diff: string;
  try {
    ({ stdout: diff } = await execFileP("git", ["diff", "--cached", "--stat", "-p"], {
      cwd: root.fsPath,
      maxBuffer: 4_000_000,
    }));
  } catch (err) {
    vscode.window.showWarningMessage(`Wright: git diff failed — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!diff.trim()) {
    vscode.window.showInformationMessage("Wright: nothing staged. Stage changes first (git add).");
    return;
  }

  const client = new ModelClient(nvidiaProvider({ apiKeys: config.apiKeys, chatModel: config.fastModel }));
  const message = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: "Wright: writing commit message…" },
    async () => {
      const result = await client.complete({
        model: config.fastModel,
        messages: [
          {
            role: "system",
            content:
              "Write a git commit message for the staged diff. First line: imperative summary under 72 chars " +
              "(conventional-commit prefix like feat:/fix:/refactor: when it fits). If the change is non-trivial, " +
              "add a blank line then 1-3 short bullet points. Return ONLY the commit message.",
          },
          { role: "user", content: diff.slice(0, 24_000) },
        ],
        max_tokens: 300,
        temperature: 0.3,
      });
      return (result.message.content ?? "").trim().replace(/^```\w*\n?|```$/g, "").trim();
    },
  ).then(
    (m) => m,
    (err) => {
      vscode.window.showErrorMessage(`Wright: commit message failed — ${err instanceof Error ? err.message : String(err)}`);
      return "";
    },
  );
  if (!message) return;

  // Drop it into the SCM input box via the built-in git extension.
  const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: Array<{ inputBox: { value: string } }> } }>("vscode.git");
  const api = gitExt?.exports.getAPI(1);
  const repo = api?.repositories[0];
  if (repo) {
    repo.inputBox.value = message;
    await vscode.commands.executeCommand("workbench.view.scm");
  } else {
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage("Wright: commit message copied to clipboard.");
  }
}
