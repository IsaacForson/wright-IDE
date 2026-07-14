import * as vscode from "vscode";
import { ChatViewProvider, ORIGINAL_SCHEME } from "./ChatViewProvider.js";
import { IndexService } from "./IndexService.js";
import { PROPOSED_SCHEME, inlineEdit, proposedContentProvider } from "./inlineEdit.js";
import { WrightCompletionProvider } from "./autocomplete.js";
import { BugWatcher } from "./bugWatcher.js";
import { generateCommitMessage } from "./gitCommit.js";
import { getConfig } from "./config.js";
import { WrightSettingsPanel } from "./settingsPanel.js";
import { UsageTracker } from "./usageTracker.js";
import { WrightUsagePanel } from "./usagePanel.js";
import { setUsageReporter } from "./providers.js";
import {
  applyBuiltinChatVisibility,
  getShowBuiltinChat,
  restoreBuiltinChatOnExit,
} from "./builtinChat.js";

export function activate(context: vscode.ExtensionContext): void {
  // Sync host Chat visibility from Wright's setting (default: show built-in chat).
  void applyBuiltinChatVisibility(getShowBuiltinChat());

  const indexService = new IndexService(getConfig().embedModel);
  const chatProvider = new ChatViewProvider(context.extensionUri, indexService, context.workspaceState);

  // Cross-provider usage tracking (attributed to the provider that served each request).
  const usage = new UsageTracker(context.globalState);
  setUsageReporter((i) => usage.record(i.provider, i.model, i.inputTokens, i.outputTokens));

  context.subscriptions.push(
    indexService,
    usage,
    vscode.commands.registerCommand("wright.usage", () => WrightUsagePanel.show(usage)),
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
    vscode.commands.registerCommand("wright.addToChat", (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      void chatProvider.addUrisToChat(uris?.length ? uris : uri ? [uri] : undefined),
    ),
    vscode.commands.registerCommand("wright.explainSelection", () => void chatProvider.runSelectionAction("explain")),
    vscode.commands.registerCommand("wright.reviewSelection", () => void chatProvider.runSelectionAction("review")),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new WrightCompletionProvider()),
    new BugWatcher(),
    // If Wright is disabled/uninstalled, never leave built-in chat hidden.
    {
      dispose: () => {
        void restoreBuiltinChatOnExit();
      },
    },
  );

  // Wright lives in the secondary (right) sidebar — open it there on startup.
  void (async () => {
    try {
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("wright.chat.focus");
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    } catch {
      // Layout not ready yet — harmless.
    }
  })();
}

export function deactivate(): void {
  void restoreBuiltinChatOnExit();
}
