import * as vscode from "vscode";
import { ModelClient, ModelError, nvidiaProvider } from "@wright/core";
import { getConfig } from "./config.js";

/**
 * Inline edit (Phase 6, Cmd+K style): select code, describe a change, get
 * it rewritten in place. Single-shot, low latency — routed to the FAST
 * model, never the agent loop. With no selection, generates at the cursor.
 * The edit lands in the buffer (not on disk): review it in place, undo
 * (Cmd+Z) to reject, save to accept.
 */

const SYSTEM = `You are a precise code editing engine inside an editor.
Return ONLY the code that replaces the target region — no explanations, no markdown fences, no surrounding file content.
Match the file's existing style and the indentation of the original region exactly.`;

const CONTEXT_LINES = 60;

export async function inlineEdit(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Wright: open a file to use inline edit.");
    return;
  }
  const config = getConfig();
  if (!config.apiKey) {
    vscode.window.showWarningMessage("Wright: no NVIDIA API key configured.");
    return;
  }

  const doc = editor.document;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;

  const instruction = await vscode.window.showInputBox({
    prompt: hasSelection ? "Wright: how should the selected code change?" : "Wright: what code should be generated here?",
    placeHolder: hasSelection ? "e.g. make this async and add error handling" : "e.g. a debounce helper with cancel()",
  });
  if (!instruction?.trim()) return;

  // The region we replace: the selection, or the cursor position for inserts.
  const range = hasSelection
    ? new vscode.Range(selection.start, selection.end)
    : new vscode.Range(selection.active, selection.active);
  const target = hasSelection ? doc.getText(range) : "";

  const beforeStart = Math.max(0, range.start.line - CONTEXT_LINES);
  const afterEnd = Math.min(doc.lineCount - 1, range.end.line + CONTEXT_LINES);
  const before = doc.getText(new vscode.Range(new vscode.Position(beforeStart, 0), range.start));
  const after = doc.getText(new vscode.Range(range.end, doc.lineAt(afterEnd).range.end));

  const user = [
    `File: ${vscode.workspace.asRelativePath(doc.uri)} (language: ${doc.languageId})`,
    ``,
    `Code before the target region:`,
    "```",
    before,
    "```",
    hasSelection ? `Target region to REPLACE:\n\`\`\`\n${target}\n\`\`\`` : `The target region is EMPTY — generate code to insert at this exact position.`,
    `Code after the target region:`,
    "```",
    after,
    "```",
    ``,
    `Instruction: ${instruction}`,
  ].join("\n");

  const client = new ModelClient(
    nvidiaProvider({ apiKey: config.apiKey, chatModel: config.fastModel }),
  );

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Wright: editing…", cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        return await client.complete(
          {
            model: config.fastModel,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: user },
            ],
            max_tokens: 4_096,
            temperature: 0.2,
          },
          { signal: controller.signal },
        );
      } catch (err) {
        if (err instanceof ModelError && err.kind === "aborted") return undefined;
        throw err;
      }
    },
  ).then(
    (r) => r,
    (err) => {
      vscode.window.showErrorMessage(`Wright inline edit failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    },
  );

  if (!result) return;
  const code = stripFences(result.message.content ?? "");
  if (!code.trim()) {
    vscode.window.showWarningMessage("Wright: the model returned no code.");
    return;
  }

  await editor.edit((edit) => edit.replace(range, code));
  vscode.window.setStatusBarMessage("Wright: edit applied — Cmd+Z to undo, save to accept", 6_000);
}

function stripFences(text: string): string {
  let out = text.trim();
  const fence = out.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1]!;
  return out;
}
