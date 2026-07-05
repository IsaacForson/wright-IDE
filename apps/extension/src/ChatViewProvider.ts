import * as vscode from "vscode";
import {
  Agent,
  ModelClient,
  ModelError,
  TrackedHost,
  agentSystemPrompt,
  createBuiltinTools,
  createCodebaseSearchTool,
  nvidiaProvider,
} from "@wright/core";
import { NodeWorkspaceHost } from "@wright/core/node";
import { IndexService } from "./IndexService.js";
import { getConfig } from "./config.js";
import { workspaceRoot } from "./workspace.js";
import type { HostToWebview, UiItem, WebviewToHost } from "./protocol.js";

/** Virtual document scheme serving pre-edit snapshots for the diff editor. */
export const ORIGINAL_SCHEME = "wright-original";

/** Models offered in the picker — all verified tool-capable on NVIDIA NIM. */
const KNOWN_MODELS = [
  "z-ai/glm-5.2",
  "deepseek-ai/deepseek-v4-pro",
  "moonshotai/kimi-k2.6",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-8b-instruct",
];

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "wright.chat";

  private view: vscode.WebviewView | undefined;
  private agent: Agent | undefined;
  private tracker: TrackedHost | undefined;
  private model: string;
  private abort: AbortController | undefined;
  /** Parallel transcript for rebuilding the webview on reload. */
  private items: UiItem[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexService: IndexService,
  ) {
    this.model = getConfig().chatModel;
  }

  /** Serves original file content to the left side of diff views. */
  readonly originalContentProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => this.tracker?.snapshot(uri.path.replace(/^\//, "")) ?? "",
  };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
  }

  newChat(): void {
    this.abort?.abort();
    this.agent = undefined;
    // Changes stay on disk; starting a new chat just stops tracking them.
    this.tracker = undefined;
    this.items = [];
    this.sendState(false);
  }

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private sendState(busy: boolean): void {
    const models = KNOWN_MODELS.includes(this.model) ? KNOWN_MODELS : [this.model, ...KNOWN_MODELS];
    this.post({
      type: "state",
      items: this.items,
      model: this.model,
      models,
      busy,
      changes: this.tracker?.changes() ?? [],
    });
  }

  private sendChanges(): void {
    this.post({ type: "changes", changes: this.tracker?.changes() ?? [] });
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.sendState(this.abort !== undefined);
        return;
      case "newChat":
        this.newChat();
        return;
      case "stop":
        this.abort?.abort();
        return;
      case "setModel":
        this.model = msg.model;
        this.agent = undefined; // next turn builds a fresh agent on the new model
        return;
      case "send":
        await this.handleSend(msg.text);
        return;
      case "openDiff":
        await this.openDiff(msg.path);
        return;
      case "keepFile":
        this.tracker?.keep(msg.path);
        this.sendChanges();
        return;
      case "revertFile":
        await this.tracker?.revert(msg.path);
        this.sendChanges();
        return;
      case "keepAll":
        this.tracker?.keepAll();
        this.sendChanges();
        return;
      case "revertAll":
        await this.tracker?.revertAll();
        this.sendChanges();
        return;
    }
  }

  private async openDiff(relPath: string): Promise<void> {
    const root = workspaceRoot();
    if (!root || !this.tracker) return;
    const kind = this.tracker.snapshot(relPath) === null ? "created" : "edited";
    const original = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}` });
    const current = vscode.Uri.joinPath(root, relPath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      current,
      `${relPath} (Wright: ${kind})`,
      { preview: true },
    );
  }

  private async buildAgent(apiKey: string): Promise<Agent> {
    const root = workspaceRoot();
    if (!root) throw new Error("Open a folder first — Wright's agent needs a workspace to work in.");
    const config = getConfig();
    const client = new ModelClient(
      nvidiaProvider({ apiKey, chatModel: this.model, fastModel: config.fastModel }),
    );
    this.tracker ??= new TrackedHost(new NodeWorkspaceHost(root.fsPath));
    const tools = createBuiltinTools(this.tracker);
    const indexer = await this.indexService.ensure(client, root.fsPath);
    if (indexer) tools.push(createCodebaseSearchTool(indexer));
    return new Agent({
      client,
      model: this.model,
      tools,
      systemPrompt: agentSystemPrompt({ workspaceName: vscode.workspace.name }),
      approve: async (name, args) => {
        const detail = name === "run_command" ? String(args.command ?? "") : JSON.stringify(args);
        const choice = await vscode.window.showWarningMessage(
          `Wright wants to run: ${detail}`,
          { modal: true },
          "Run",
        );
        return choice === "Run";
      },
    });
  }

  private async handleSend(text: string): Promise<void> {
    if (this.abort) return; // already running; UI disables send, but guard anyway

    const config = getConfig();
    if (!config.apiKey) {
      this.post({
        type: "error",
        message:
          "No NVIDIA API key found. Set `wright.nvidia.apiKey` in Settings (or put NVIDIA_API_KEY in the workspace .env).",
      });
      return;
    }

    try {
      this.agent ??= await this.buildAgent(config.apiKey);
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    this.items.push({ kind: "text", role: "user", content: text });
    this.sendState(true);
    text = await this.expandMentions(text);

    this.abort = new AbortController();
    const start = Date.now();
    let currentText: Extract<UiItem, { kind: "text" }> | undefined;

    try {
      for await (const event of this.agent.run(text, { signal: this.abort.signal })) {
        switch (event.type) {
          case "text":
            if (!currentText) {
              currentText = { kind: "text", role: "assistant", content: "" };
              this.items.push(currentText);
              this.post({ type: "assistantStart" });
            }
            currentText.content += event.text;
            this.post({ type: "delta", text: event.text });
            break;
          case "tool_start": {
            currentText = undefined;
            const argsSummary = summarizeArgs(event.name, event.args);
            this.items.push({ kind: "tool", id: event.id, name: event.name, argsSummary, status: "running" });
            this.post({ type: "toolStart", id: event.id, name: event.name, argsSummary });
            break;
          }
          case "tool_done": {
            const status = !event.approved ? "declined" : event.result.ok ? "ok" : "error";
            const item = this.items.find((i) => i.kind === "tool" && i.id === event.id);
            if (item?.kind === "tool") {
              item.status = status;
              item.output = event.result.output;
            }
            this.post({ type: "toolDone", id: event.id, status, output: event.result.output });
            if (event.name === "write_file" || event.name === "edit_file") this.sendChanges();
            break;
          }
          case "done": {
            const secs = ((Date.now() - start) / 1000).toFixed(1);
            const stats =
              event.usage.total_tokens > 0
                ? `${secs}s · ${event.iterations} step(s) · ${event.usage.prompt_tokens}→${event.usage.completion_tokens} tok`
                : `${secs}s · ${event.iterations} step(s)`;
            this.post({ type: "turnDone", stats });
            break;
          }
        }
      }
    } catch (err) {
      if (err instanceof ModelError && err.kind === "aborted") {
        this.post({ type: "turnDone", stats: "cancelled" });
      } else {
        const message = err instanceof ModelError ? `[${err.kind}] ${err.message}` : String(err);
        this.post({ type: "error", message });
        this.post({ type: "turnDone" });
      }
    } finally {
      this.abort = undefined;
      this.sendState(false);
    }
  }

  /**
   * @-mentions (Phase 5.5): expand `@path/to/file` tokens in the user's
   * message into attached file contents, forcing exact context in.
   */
  private async expandMentions(text: string): Promise<string> {
    if (!this.tracker || !text.includes("@")) return text;
    const mentions = [...text.matchAll(/@([\w@./\\-]+)/g)].map((m) => m[1]!);
    const attachments: string[] = [];
    for (const rel of new Set(mentions)) {
      try {
        const content = await this.tracker.readFile(rel);
        attachments.push(`\n\n[Attached file @${rel}]\n\`\`\`\n${content.slice(0, 16_000)}\n\`\`\``);
      } catch {
        // not a file — leave the token as plain text
      }
    }
    return attachments.length > 0 ? text + attachments.join("") : text;
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Wright</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "list_dir":
      return String(args.path ?? "");
    case "write_file":
      return `${String(args.path ?? "")} (${String((args.content as string | undefined)?.length ?? 0)} chars)`;
    case "edit_file":
      return String(args.path ?? "");
    case "search":
      return String(args.query ?? "");
    case "run_command":
      return String(args.command ?? "");
    default: {
      const json = JSON.stringify(args);
      return json.length > 80 ? json.slice(0, 80) + "…" : json;
    }
  }
}
