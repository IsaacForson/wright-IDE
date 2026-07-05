import * as vscode from "vscode";
import { ChatViewProvider, ORIGINAL_SCHEME } from "./ChatViewProvider.js";
import { IndexService } from "./IndexService.js";
import { PROPOSED_SCHEME, inlineEdit, proposedContentProvider } from "./inlineEdit.js";
import { WrightCompletionProvider } from "./autocomplete.js";
import { generateCommitMessage } from "./gitCommit.js";
import { getConfig } from "./config.js";
import { WrightSettingsPanel } from "./settingsPanel.js";

export function activate(context: vscode.ExtensionContext): void {
  const indexService = new IndexService(getConfig().embedModel);
  const chatProvider = new ChatViewProvider(context.extensionUri, indexService, context.workspaceState);

  context.subscriptions.push(
    indexService,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, chatProvider.originalContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedContentProvider),
    vscode.commands.registerCommand("wright.newChat", () => chatProvider.newChat()),
    vscode.commands.registerCommand("wright.focusChat", () =>
      vscode.commands.executeCommand("wright.chat.focus"),
    ),
    vscode.commands.registerCommand("wright.chatHistory", () => chatProvider.toggleHistory()),
    vscode.commands.registerCommand("wright.openSettings", () => WrightSettingsPanel.show(context.extensionUri)),
    vscode.commands.registerCommand("wright.rebuildIndex", () => void indexService.rebuild()),
    vscode.commands.registerCommand("wright.inlineEdit", () => void inlineEdit()),
    vscode.commands.registerCommand("wright.generateCommitMessage", () => void generateCommitMessage()),
    vscode.commands.registerCommand("wright.addSelectionToChat", () => void chatProvider.addSelectionToChat()),
    vscode.commands.registerCommand("wright.explainSelection", () => void chatProvider.runSelectionAction("explain")),
    vscode.commands.registerCommand("wright.reviewSelection", () => void chatProvider.runSelectionAction("review")),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new WrightCompletionProvider()),
  );

  // Open the Wright panel (secondary sidebar) on startup, then hand focus back
  // to the editor so it behaves like a persistent chat, not a focus grab.
  void (async () => {
    try {
      await vscode.commands.executeCommand("wright.chat.focus");
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    } catch {
      // View not ready yet (e.g. first-run layout restore) — harmless.
    }
  })();
}

export function deactivate(): void {}
