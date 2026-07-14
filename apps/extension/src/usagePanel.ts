import * as vscode from "vscode";
import type { ProviderUsage, UsageTracker } from "./usageTracker.js";
import { getConfig } from "./config.js";

/**
 * Cross-provider usage dashboard — a webview showing tokens & request counts
 * per provider (and per model), for session / today / all-time, with cost
 * estimates when pricing is configured. Live-updates as requests happen.
 */
export class WrightUsagePanel {
  private static current: WrightUsagePanel | undefined;

  static show(tracker: UsageTracker): void {
    if (WrightUsagePanel.current) {
      WrightUsagePanel.current.panel.reveal();
      return;
    }
    WrightUsagePanel.current = new WrightUsagePanel(tracker);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly tracker: UsageTracker) {
    this.panel = vscode.window.createWebviewPanel("wrightUsage", "Wright: Usage", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage((m: { type: string; scope?: "session" | "today" | "allTime" }) => {
      if (m.type === "reset" && m.scope) this.tracker.reset(m.scope);
    }, undefined, this.disposables);
    this.disposables.push(this.tracker.onChange(() => this.render()));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.render();
  }

  private render(): void {
    this.panel.webview.html = this.html();
  }

  private dispose(): void {
    WrightUsagePanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private html(): string {
    const snap = this.tracker.snapshot();
    const cfg = getConfig();
    const priceIn = cfg.priceInPer1M;
    const priceOut = cfg.priceOutPer1M;

    const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
    const cost = (u: ProviderUsage) => (priceIn > 0 || priceOut > 0 ? (u.inputTokens / 1e6) * priceIn + (u.outputTokens / 1e6) * priceOut : undefined);

    const table = (title: string, scope: string, data: Record<string, ProviderUsage>) => {
      const providers = Object.entries(data).sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens));
      const totalReq = providers.reduce((s, [, u]) => s + u.requests, 0);
      const totalTok = providers.reduce((s, [, u]) => s + u.inputTokens + u.outputTokens, 0);
      const maxTok = Math.max(1, ...providers.map(([, u]) => u.inputTokens + u.outputTokens));
      if (providers.length === 0) {
        return `<section><div class="head"><h2>${title}</h2><button data-reset="${scope}">Reset</button></div><p class="empty">No requests yet.</p></section>`;
      }
      const rows = providers
        .map(([name, u]) => {
          const tok = u.inputTokens + u.outputTokens;
          const c = cost(u);
          const models = Object.entries(u.models)
            .map(([m, mu]) => `<div class="model">${escapeHtml(m)} <span>${fmt(mu.inputTokens + mu.outputTokens)} tok · ${mu.requests}×</span></div>`)
            .join("");
          return `<div class="prov">
            <div class="prow">
              <span class="pname">${escapeHtml(name)}</span>
              <span class="pstat">${u.requests}× · ${fmt(u.inputTokens)}↑ ${fmt(u.outputTokens)}↓${c !== undefined ? ` · ~$${c.toFixed(c < 0.1 ? 3 : 2)}` : ""}</span>
            </div>
            <div class="bar"><div class="fill" style="width:${Math.max(3, (tok / maxTok) * 100)}%"></div></div>
            <div class="models">${models}</div>
          </div>`;
        })
        .join("");
      return `<section>
        <div class="head"><h2>${title}</h2><button data-reset="${scope}">Reset</button></div>
        <div class="totals">${totalReq} requests · ${fmt(totalTok)} tokens${cost({ requests: 0, inputTokens: providers.reduce((s, [, u]) => s + u.inputTokens, 0), outputTokens: providers.reduce((s, [, u]) => s + u.outputTokens, 0), models: {} }) !== undefined ? ` · ~$${(cost({ requests: 0, inputTokens: providers.reduce((s, [, u]) => s + u.inputTokens, 0), outputTokens: providers.reduce((s, [, u]) => s + u.outputTokens, 0), models: {} }) ?? 0).toFixed(2)}` : ""}</div>
        ${rows}
      </section>`;
    };

    const priceNote = priceIn > 0 || priceOut > 0 ? "" : `<p class="note">Set <code>wright.pricing.inputPer1M</code> / <code>outputPer1M</code> to see cost estimates. Most free tiers are $0.</p>`;

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 18px 22px; max-width: 720px; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      .note { opacity: 0.6; font-size: 12px; }
      section { margin-top: 22px; }
      .head { display: flex; align-items: center; justify-content: space-between; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 0; }
      .head button { background: transparent; border: 1px solid var(--vscode-panel-border, #444); color: var(--vscode-foreground); border-radius: 5px; padding: 2px 10px; font-size: 11px; cursor: pointer; opacity: 0.7; }
      .head button:hover { opacity: 1; }
      .totals { font-size: 12px; opacity: 0.75; margin: 6px 0 10px; }
      .empty { opacity: 0.5; font-size: 12px; }
      .prov { margin-bottom: 14px; }
      .prow { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 3px; }
      .pname { font-weight: 600; }
      .pstat { opacity: 0.65; font-variant-numeric: tabular-nums; font-size: 12px; }
      .bar { height: 6px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 3px; overflow: hidden; }
      .fill { height: 100%; background: var(--vscode-focusBorder, #4daafc); border-radius: 3px; }
      .models { margin: 5px 0 0 8px; }
      .model { font-size: 11px; opacity: 0.6; font-family: var(--vscode-editor-font-family); }
      .model span { opacity: 0.8; }
      code { background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
    </style></head><body>
      <h1>Usage across providers</h1>
      <p class="note">Tokens are attributed to the provider that actually served each request (after any failover). ${priceNote ? "" : ""}</p>
      ${priceNote}
      ${table("This session", "session", snap.session)}
      ${table("Today", "today", snap.today)}
      ${table("All time", "allTime", snap.allTime)}
      <script>
        const vscode = acquireVsCodeApi();
        for (const b of document.querySelectorAll("button[data-reset]")) {
          b.addEventListener("click", () => vscode.postMessage({ type: "reset", scope: b.dataset.reset }));
        }
      </script>
    </body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
