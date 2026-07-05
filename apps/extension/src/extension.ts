import * as vscode from "vscode";
import { ChatViewProvider, ORIGINAL_SCHEME } from "./ChatViewProvider.js";
import { IndexService } from "./IndexService.js";
import { inlineEdit } from "./inlineEdit.js";
import { WrightCompletionProvider } from "./autocomplete.js";
import { generateCommitMessage } from "./gitCommit.js";
import { getConfig } from "./config.js";

export function activate(context: vscode.ExtensionContext): void {
  const indexService = new IndexService(getConfig().embedModel);
  const chatProvider = new ChatViewProvider(context.extensionUri, indexService, context.workspaceState);

  context.subscriptions.push(
    indexService,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, chatProvider.originalContentProvider),
    vscode.commands.registerCommand("wright.newChat", () => chatProvider.newChat()),
    vscode.commands.registerCommand("wright.focusChat", () =>
      vscode.commands.executeCommand("wright.chat.focus"),
    ),
    vscode.commands.registerCommand("wright.rebuildIndex", () => void indexService.rebuild()),
    vscode.commands.registerCommand("wright.inlineEdit", () => void inlineEdit()),
    vscode.commands.registerCommand("wright.generateCommitMessage", () => void generateCommitMessage()),
    vscode.commands.registerCommand("wright.addSelectionToChat", () => void chatProvider.addSelectionToChat()),
    vscode.commands.registerCommand("wright.explainSelection", () => void chatProvider.runSelectionAction("explain")),
    vscode.commands.registerCommand("wright.reviewSelection", () => void chatProvider.runSelectionAction("review")),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new WrightCompletionProvider()),
  );
}

export function deactivate(): void {}
