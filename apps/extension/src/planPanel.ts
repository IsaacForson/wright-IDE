import * as vscode from "vscode";
import { PLAN_PANEL_CSS, renderPlanBody, type PlanState } from "./planFile.js";

/**
 * Wright's plan viewer — a dedicated panel (like Cursor's) rendered entirely
 * from in-memory state pushed by ChatViewProvider. The plan streams in live
 * while it's being drafted, then shows real checkboxes / progress / a Build
 * button whose state follows the phase. No file on disk — the host owns the
 * state and re-pushes it whenever the panel (re)opens.
 */
export class PlanPanel {
  private static instance: PlanPanel | undefined;
  private static lastState: PlanState | undefined;

  /** Wired by extension.ts — the ▶ Build button hands control to the chat agent. */
  static onBuild: (() => void) | undefined;

  /** Push new plan state; opens the panel if needed. */
  static render(state: PlanState): void {
    PlanPanel.lastState = state;
    PlanPanel.ensure().push(state);
  }

  /** Reopen the panel showing the current plan (for the chat "Open plan panel" link). */
  static reveal(): void {
    if (!PlanPanel.lastState) {
      vscode.window.showInformationMessage("Wright: no active plan — create one from Plan mode in the chat.");
      return;
    }
    PlanPanel.ensure().push(PlanPanel.lastState);
  }

  /** Command entry point (wright.openPlan). */
  static showLatest(): void {
    PlanPanel.reveal();
  }

  private static ensure(): PlanPanel {
    if (!PlanPanel.instance) PlanPanel.instance = new PlanPanel();
    return PlanPanel.instance;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "wrightPlan",
      "Wright: Plan",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.shell();
    this.panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === "ready" && PlanPanel.lastState) this.push(PlanPanel.lastState);
      if (m?.type === "build") PlanPanel.onBuild?.();
    });
    this.panel.onDidDispose(() => {
      PlanPanel.instance = undefined;
    });
  }

  private push(state: PlanState): void {
    const done = state.doc?.steps.filter((s) => s.done).length ?? 0;
    const total = state.doc?.steps.length ?? 0;
    this.panel.title =
      state.phase === "drafting" ? "Wright: Plan (drafting…)"
      : state.phase === "done" || (total > 0 && done === total) ? "Wright: Plan ✓"
      : `Wright: Plan ${done}/${total}`;
    void this.panel.webview.postMessage({ type: "render", html: renderPlanBody(state) });
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
  }

  private shell(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>${PLAN_PANEL_CSS}</style></head>
      <body><div id="root"></div>
      <script>
        const api = acquireVsCodeApi();
        window.addEventListener("message", (e) => {
          const m = e.data;
          if (m && m.type === "render") document.getElementById("root").innerHTML = m.html;
        });
        document.addEventListener("click", (e) => {
          const b = e.target.closest && e.target.closest("#build");
          if (b && !b.disabled) api.postMessage({ type: "build" });
        });
        api.postMessage({ type: "ready" });
      </script></body></html>`;
  }
}
