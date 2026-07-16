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
import { CodemapPanel } from "./codemapPanel.js";
import { PlanPanel } from "./planPanel.js";
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
  // ▶ Build in the Plan panel hands the plan file to the chat agent.
  PlanPanel.onBuild = (uri, rel) => chatProvider.buildPlan(uri, rel);

  // Cross-provider usage tracking (attributed to the provider that served each request).
  const usage = new UsageTracker(context.globalState);
  setUsageReporter((i) => usage.record(i.provider, i.model, i.inputTokens, i.outputTokens));

  // No-Shift image drop rescue: stock VS Code intercepts OS file drops and
  // opens them as tabs (only Shift+drop reaches the webview). When an IMAGE
  // from OUTSIDE the workspace opens while the Wright chat is visible — the
  // signature of a screenshot dropped on the chat — attach it to the composer
  // and close the tab. Workspace images are untouched (normal browsing).
  const dropRescue = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
    if (!chatProvider.isViewVisible()) return;
    for (const tab of e.opened) {
      const input = tab.input;
      const uri =
        input instanceof vscode.TabInputCustom ? input.uri
        : input instanceof vscode.TabInputText ? input.uri
        : undefined;
      if (!uri || uri.scheme !== "file") continue;
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(uri.fsPath)) continue;
      if (vscode.workspace.getWorkspaceFolder(uri)) continue; // in-workspace = browsing, not a drop
      if (await chatProvider.attachExternalImage(uri)) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          /* tab already gone */
        }
        vscode.window.setStatusBarMessage("Wright: image attached to chat (dropped without Shift)", 5_000);
      }
    }
  });

  context.subscriptions.push(
    indexService,
    usage,
    dropRescue,
    vscode.commands.registerCommand("wright.usage", () => WrightUsagePanel.show(usage)),
    vscode.commands.registerCommand("wright.memories", () => void chatProvider.manageMemories()),
    vscode.commands.registerCommand("wright.newWorkflow", () => void chatProvider.newWorkflow()),
    vscode.commands.registerCommand("wright.codemap", () => void CodemapPanel.show()),
    vscode.commands.registerCommand("wright.openPlan", () => void PlanPanel.showLatest()),
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
