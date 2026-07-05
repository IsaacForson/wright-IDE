import * as vscode from "vscode";
import { spawn } from "node:child_process";

/**
 * Local Ollama integration: detect/start the server, list installed models,
 * and pull new ones with progress — so local models are zero-config.
 * We never stop the server: it idles at ~0 cost and unloads models from
 * memory by itself after a few minutes of inactivity.
 */

function BASE(): string {
  return (vscode.workspace.getConfiguration("wright").get<string>("ollama.url") || "http://localhost:11434").replace(/\/$/, "");
}

export function ollamaOpenAiBase(): string {
  return `${BASE()}/v1`;
}

export function isRemoteOllama(): boolean {
  return !/localhost|127\.0\.0\.1/.test(BASE());
}

export interface LocalModel {
  name: string;
  sizeGb?: number;
  tools?: boolean;
}

export async function isOllamaUp(timeoutMs = 1_200): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${BASE()}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Start Ollama if it isn't running (macOS app first, CLI daemon fallback). */
export async function ensureOllamaRunning(): Promise<boolean> {
  if (await isOllamaUp()) return true;
  if (isRemoteOllama()) return false; // can't start a remote server from here
  try {
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Ollama"], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("ollama", ["serve"], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // binary not found — fall through to the poll, then report failure
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isOllamaUp()) return true;
  }
  return false;
}

export async function listLocalModels(): Promise<LocalModel[]> {
  try {
    const res = await fetch(`${BASE()}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string; size?: number; capabilities?: string[] }> };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeGb: m.size ? Math.round((m.size / 1e9) * 10) / 10 : undefined,
      tools: m.capabilities?.includes("tools"),
    }));
  } catch {
    return [];
  }
}

/** Curated coding models offered for one-click download (sized for ≤16 GB Macs). */
export const RECOMMENDED_LOCAL_MODELS: Array<{ id: string; blurb: string }> = [
  { id: "qwen2.5-coder:14b", blurb: "★ best local coder for 16 GB · agentic tools · ~9 GB" },
  { id: "qwen3:14b", blurb: "★ best local reasoning & chat · thinking · tools · ~9.3 GB" },
  { id: "qwen2.5-coder:7b", blurb: "lighter coder · tools · ~4.7 GB" },
  { id: "llama3.2:3b", blurb: "tiny & fast · tools · ~2 GB" },
];

/** Pull a model with live progress; resolves true on success. */
export async function pullModel(name: string): Promise<boolean> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Ollama: downloading ${name}`, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const res = await fetch(`${BASE()}/api/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: name, stream: true }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastPct = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const evt = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
              if (evt.error) throw new Error(evt.error);
              if (evt.total && evt.completed !== undefined) {
                const pct = Math.round((evt.completed / evt.total) * 100);
                progress.report({ message: `${evt.status ?? ""} ${pct}%`, increment: pct - lastPct });
                lastPct = pct;
              } else if (evt.status) {
                progress.report({ message: evt.status });
              }
            } catch (err) {
              if (err instanceof Error && !(err instanceof SyntaxError)) throw err;
            }
          }
        }
        vscode.window.showInformationMessage(`Ollama: ${name} is ready to use.`);
        return true;
      } catch (err) {
        if (!controller.signal.aborted) {
          vscode.window.showErrorMessage(`Ollama pull failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return false;
      }
    },
  );
}

/** Remove a downloaded model from disk (frees its full size). */
export async function deleteModel(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE()}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Friendly guidance when Ollama isn't installed/reachable. */
export async function offerOllamaInstall(): Promise<void> {
  const remote = isRemoteOllama();
  const choice = await vscode.window.showWarningMessage(
    remote
      ? `Wright: can't reach the Ollama server at ${BASE()}. Check the URL in settings and that the server is running.`
      : "Wright: Ollama isn't installed. It's a free one-time install (~1 min) — after that, local models are one-click.",
    ...(remote ? ["Open Settings"] : ["Download Ollama"]),
  );
  if (choice === "Download Ollama") {
    await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
  } else if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "wright.ollama.url");
  }
}
