import * as vscode from "vscode";
import { isOllamaUp, ollamaOpenAiBase } from "./ollama.js";

/**
 * Ambient bug-watcher: on each manual save, a LOCAL model quietly scans the
 * file for likely bugs and surfaces them as "Wright" diagnostics (info-level,
 * non-blocking). Runs only on the user's own saves — the agent writes bytes
 * via fs, which never fires onDidSaveTextDocument — and never touches cloud
 * quota. Opt-in via wright.bugWatcher.enabled.
 */

const DEBOUNCE_MS = 1_500;
const MAX_FILE_CHARS = 12_000;
const LANGS = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact", "python", "go", "rust", "java", "cpp", "c", "csharp", "php", "ruby"]);

interface BugFinding {
  line: number;
  message: string;
  severity?: "warning" | "info";
}

export class BugWatcher implements vscode.Disposable {
  private readonly diags = vscode.languages.createDiagnosticCollection("wright-bugs");
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private downUntil = 0;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.queue(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.diags.delete(doc.uri)),
    );
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("wright").get<boolean>("bugWatcher.enabled") ?? false;
  }

  private queue(doc: vscode.TextDocument): void {
    if (!this.enabled() || doc.uri.scheme !== "file" || !LANGS.has(doc.languageId)) return;
    if (Date.now() < this.downUntil) return;
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => void this.scan(doc), DEBOUNCE_MS));
  }

  private async scan(doc: vscode.TextDocument): Promise<void> {
    this.timers.delete(doc.uri.toString());
    if (!this.enabled() || doc.isClosed) return;
    if (!(await isOllamaUp())) {
      this.downUntil = Date.now() + 60_000;
      return;
    }
    const model = vscode.workspace.getConfiguration("wright").get<string>("bugWatcher.model")
      || vscode.workspace.getConfiguration("wright").get<string>("fallback.ollamaModel")
      || "qwen2.5-coder:14b";
    const text = doc.getText().slice(0, MAX_FILE_CHARS);
    const numbered = text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");

    let findings: BugFinding[];
    try {
      findings = await this.ask(model, doc.languageId, numbered);
    } catch {
      return; // best-effort; stay quiet on any failure
    }
    if (doc.isClosed) return;
    const diagnostics = findings
      .filter((f) => f.line >= 1 && f.line <= doc.lineCount)
      .slice(0, 20)
      .map((f) => {
        const range = doc.lineAt(f.line - 1).range;
        const d = new vscode.Diagnostic(
          range,
          `${f.message} — Wright`,
          f.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
        );
        d.source = "Wright";
        return d;
      });
    this.diags.set(doc.uri, diagnostics);
  }

  private async ask(model: string, lang: string, numberedCode: string): Promise<BugFinding[]> {
    const res = await fetch(`${ollamaOpenAiBase()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content:
              "You review code for LIKELY BUGS only (null/undefined access, off-by-one, unhandled errors, " +
              "await/async mistakes, resource leaks, obvious logic errors). Ignore style/naming. Be conservative — " +
              'only flag things you\'re confident about. Reply ONLY with JSON: {"bugs":[{"line":N,"message":"...","severity":"warning|info"}]}. ' +
              "Empty array if the code looks fine.",
          },
          { role: "user", content: `Language: ${lang}\n\n${numberedCode}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { bugs?: BugFinding[] };
    return Array.isArray(parsed.bugs) ? parsed.bugs : [];
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
    this.diags.dispose();
  }
}
