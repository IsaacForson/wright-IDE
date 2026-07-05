import * as vscode from "vscode";
import { ChatViewProvider, ORIGINAL_SCHEME } from "./ChatViewProvider.js";
import { IndexService } from "./IndexService.js";
import { getConfig } from "./config.js";

export function activate(context: vscode.ExtensionContext): void {
  const indexService = new IndexService(getConfig().embedModel);
  const chatProvider = new ChatViewProvider(context.extensionUri, indexService);

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
  );
}

export function deactivate(): void {}
