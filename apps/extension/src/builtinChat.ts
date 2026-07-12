import * as vscode from "vscode";

/**
 * Wright can temporarily hide the host IDE Chat via chat.disableAIFeatures.
 * That must never stick after Wright is gone — uninstall/deactivate always
 * restores built-in chat.
 */

export function getShowBuiltinChat(): boolean {
  return vscode.workspace.getConfiguration("wright").get<boolean>("ui.showBuiltinChat", true);
}

/** Apply Wright's preference onto the host `chat.disableAIFeatures` switch. */
export async function applyBuiltinChatVisibility(show: boolean): Promise<void> {
  const chat = vscode.workspace.getConfiguration("chat");
  const hide = !show;
  if (chat.get<boolean>("disableAIFeatures") === hide) return;
  await chat.update("disableAIFeatures", hide, vscode.ConfigurationTarget.Global);
}

/** Always leave built-in chat enabled when Wright is disabled/uninstalled. */
export async function restoreBuiltinChatOnExit(): Promise<void> {
  await vscode.workspace
    .getConfiguration("chat")
    .update("disableAIFeatures", false, vscode.ConfigurationTarget.Global);
}

export async function openBuiltinChatPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
    await vscode.commands.executeCommand("workbench.action.chat.open");
  } catch {
    try {
      await vscode.commands.executeCommand("workbench.panel.chat.view.copilot.focus");
    } catch {
      /* host chat command names vary by IDE */
    }
  }
}
