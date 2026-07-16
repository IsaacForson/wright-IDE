import * as vscode from "vscode";
import { parsePlanDoc, renderPlanHtml } from "./planFile.js";

/**
 * Wright's plan viewer — a dedicated panel (like Cursor's) that renders the
 * .wright/plans/*.md document with real checkboxes, an ember progress bar and
 * a "current step" marker. Watches the file and re-renders on every tick, so
 * progress survives tab switches: it always reflects what's on disk.
 */
export class PlanPanel {
  private static current: PlanPanel | undefined;

  /** Wired by extension.ts — the ▶ Build button hands the plan to the agent. */
  static onBuild: ((uri: vscode.Uri, relPath: string) => void) | undefined;

  static async show(uri: vscode.Uri, relPath: string): Promise<void> {
    if (!PlanPanel.current) PlanPanel.current = new PlanPanel();
    await PlanPanel.current.bind(uri, relPath);
  }

  /** Open the most recent plan in the workspace's .wright/plans folder. */
  static async showLatest(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      vscode.window.showInformationMessage("Wright: open a folder to view plans.");
      return;
    }
    const dir = vscode.Uri.joinPath(root, ".wright", "plans");
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const latest = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".md"))
        .map(([name]) => name)
        .sort()
        .pop();
      if (!latest) throw new Error("empty");
      await PlanPanel.show(vscode.Uri.joinPath(dir, latest), `.wright/plans/${latest}`);
    } catch {
      vscode.window.showInformationMessage("Wright: no plans yet — run one from Plan mode in the chat.");
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private watcher: vscode.FileSystemWatcher | undefined;
  private uri: vscode.Uri | undefined;
  private relPath = "";

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "wrightPlan",
      "Wright: Plan",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === "build" && this.uri) PlanPanel.onBuild?.(this.uri, this.relPath);
    });
    this.panel.onDidDispose(() => {
      PlanPanel.current = undefined;
      this.watcher?.dispose();
    });
  }

  private async bind(uri: vscode.Uri, relPath: string): Promise<void> {
    this.uri = uri;
    this.relPath = relPath;
    this.watcher?.dispose();
    const dir = uri.path.slice(0, uri.path.lastIndexOf("/"));
    const base = uri.path.split("/").pop()!;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), base),
    );
    this.watcher.onDidChange(() => void this.render());
    this.watcher.onDidCreate(() => void this.render());
    await this.render();
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
  }

  private async render(): Promise<void> {
    if (!this.uri) return;
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.uri)).toString("utf8");
      const doc = parsePlanDoc(raw);
      const [done, total] = [doc.steps.filter((s) => s.done).length, doc.steps.length];
      this.panel.title = total > 0 && done === total ? "Wright: Plan ✓" : `Wright: Plan ${done}/${total}`;
      this.panel.webview.html = renderPlanHtml(doc, this.relPath);
    } catch {
      /* file mid-write or deleted — the next watcher event re-renders */
    }
  }
}
