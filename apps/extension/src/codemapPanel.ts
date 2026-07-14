import * as vscode from "vscode";
import { buildCodemap, type Codemap, type CodemapInput } from "@wright/core";

/**
 * Codemap — an architecture view built from the import graph. Scans workspace
 * source files, resolves internal imports, and renders modules, the most
 * depended-on "key files", and module→module dependencies. Every file is
 * clickable and opens in the editor.
 */
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py}";
const EXCLUDE = "**/{node_modules,dist,out,build,.git,.next,coverage,vendor}/**";
const MAX_FILES = 2500;
const MAX_BYTES = 400_000;

export class CodemapPanel {
  private static current: CodemapPanel | undefined;

  static async show(): Promise<void> {
    if (CodemapPanel.current) {
      CodemapPanel.current.panel.reveal();
      await CodemapPanel.current.render();
      return;
    }
    CodemapPanel.current = new CodemapPanel();
    await CodemapPanel.current.render();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor() {
    this.panel = vscode.window.createWebviewPanel("wrightCodemap", "Wright: Codemap", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage(
      (m: { type: string; path?: string }) => {
        if (m.type === "open" && m.path) void this.openFile(m.path);
        if (m.type === "refresh") void this.render();
      },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private async openFile(rel: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const uri = vscode.Uri.joinPath(root, rel);
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    } catch {
      vscode.window.showWarningMessage(`Wright: could not open ${rel}`);
    }
  }

  private async gather(): Promise<CodemapInput[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return [];
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE, MAX_FILES);
    const files: CodemapInput[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_BYTES) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
        files.push({ path: rel, content: Buffer.from(bytes).toString("utf8") });
      } catch {
        /* skip unreadable */
      }
    }
    return files;
  }

  private async render(): Promise<void> {
    const files = await this.gather();
    const map = buildCodemap(files, { keyFileLimit: 20 });
    this.panel.webview.html = this.html(map, files.length);
  }

  private dispose(): void {
    CodemapPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private html(map: Codemap, scanned: number): string {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const base = (p: string) => p.split("/").pop() ?? p;

    if (scanned === 0) {
      return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground)">
        <h2>Wright Codemap</h2><p>No source files found in this workspace.</p></body></html>`;
    }

    const maxDeg = Math.max(1, ...map.keyFiles.map((f) => f.importedBy));
    const keyRows = map.keyFiles
      .map(
        (f) => `<button class="file" data-path="${esc(f.path)}" title="${esc(f.path)}">
          <span class="bar" style="width:${Math.round((f.importedBy / maxDeg) * 100)}%"></span>
          <span class="fname">${esc(base(f.path))}</span>
          <span class="fpath">${esc(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "")}</span>
          <span class="deg">${f.importedBy}</span>
        </button>`,
      )
      .join("");

    const moduleCards = map.modules
      .map((m) => {
        const filesIn = map.files.filter((f) => f.module === m.name);
        const items = filesIn
          .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
          .slice(0, 40)
          .map(
            (f) =>
              `<button class="mfile" data-path="${esc(f.path)}" title="${esc(f.path)}">${esc(base(f.path))}${f.importedBy > 0 ? `<span class="mdeg">${f.importedBy}</span>` : ""}</button>`,
          )
          .join("");
        const deps = m.dependsOn.length ? `<div class="deps">→ ${m.dependsOn.map(esc).join(", ")}</div>` : "";
        return `<div class="module">
          <div class="mhead"><span class="mname">${esc(m.name)}</span><span class="mcount">${m.files} file${m.files === 1 ? "" : "s"}</span></div>
          ${deps}
          <div class="mfiles">${items}${filesIn.length > 40 ? `<span class="more">+${filesIn.length - 40} more</span>` : ""}</div>
        </div>`;
      })
      .join("");

    const edgeCount = map.edges.length;

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      :root { color-scheme: light dark; }
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; }
      h2 { margin: 0 0 2px; }
      .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 20px; }
      .sub button { margin-left: 10px; }
      h3 { margin: 26px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
      button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; text-align: left; }
      .refresh { border: 1px solid var(--vscode-button-border,transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; border-radius: 4px; font-size: 11px; }
      .keyfiles { display: flex; flex-direction: column; gap: 3px; max-width: 720px; }
      .file { position: relative; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 5px; overflow: hidden; }
      .file:hover { background: var(--vscode-list-hoverBackground); }
      .file .bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-charts-blue, #4b8bf5); opacity: .16; z-index: 0; }
      .file > span:not(.bar) { position: relative; z-index: 1; }
      .fname { font-weight: 600; }
      .fpath { color: var(--vscode-descriptionForeground); font-size: 11px; }
      .deg { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); min-width: 24px; text-align: right; }
      .modules { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
      .module { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; padding: 12px; }
      .mhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
      .mname { font-weight: 700; }
      .mcount { color: var(--vscode-descriptionForeground); font-size: 11px; }
      .deps { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 8px; }
      .mfiles { display: flex; flex-wrap: wrap; gap: 4px; }
      .mfile { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 4px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
      .mfile:hover { outline: 1px solid var(--vscode-focusBorder); }
      .mdeg { font-size: 10px; opacity: .7; }
      .more { color: var(--vscode-descriptionForeground); font-size: 11px; align-self: center; }
    </style></head><body>
      <h2>Codemap</h2>
      <div class="sub">${scanned} files · ${map.modules.length} modules · ${edgeCount} internal imports
        <button class="refresh" id="refresh">Refresh</button></div>

      <h3>Key files (most depended-on)</h3>
      <div class="keyfiles">${keyRows || '<div class="sub">No internal imports detected.</div>'}</div>

      <h3>Modules</h3>
      <div class="modules">${moduleCards}</div>

      <script>
        const vscode = acquireVsCodeApi();
        document.body.addEventListener("click", (e) => {
          const el = e.target.closest("[data-path]");
          if (el) { vscode.postMessage({ type: "open", path: el.dataset.path }); return; }
          if (e.target.closest("#refresh")) vscode.postMessage({ type: "refresh" });
        });
      </script>
    </body></html>`;
  }
}
