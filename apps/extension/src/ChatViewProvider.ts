import * as vscode from "vscode";
import {
  Agent,
  ApprovalPolicy,
  ModelClient,
  ModelError,
  TrackedHost,
  agentSystemPrompt,
  type ApprovalMode,
  type ChatMessage,
  createBuiltinTools,
  createCodebaseSearchTool,
  executionMessage,
  generatePlan,
  nvidiaProvider,
  planContext,
} from "@wright/core";
import { NodeWorkspaceHost, loadRulesFile } from "@wright/core/node";
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
  /** Composer: the drafted plan awaiting user approval. */
  private pendingPlan: { task: string; plan: string } | undefined;
  private approvalMode: ApprovalMode;
  /** Cost meter (Phase 9): tokens spent this session. */
  private sessionUsage = { input: 0, output: 0 };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexService: IndexService,
    /** Workspace-scoped persistence for chat sessions (Phase 10). */
    private readonly memento: vscode.Memento,
  ) {
    this.model = getConfig().chatModel;
    this.approvalMode = getConfig().approvalMode;
    this.restoreSession();
  }

  // ── Session persistence (Phase 10) ────────────────────────────────────

  private restoreSession(): void {
    const saved = this.memento.get<{ items: UiItem[]; messages: ChatMessage[]; model: string }>("wright.session");
    if (!saved || saved.items.length === 0) return;
    this.items = saved.items;
    this.model = saved.model || this.model;
    this.savedMessages = saved.messages;
  }

  /** Agent history to restore once the agent is first built this session. */
  private savedMessages: ChatMessage[] | undefined;

  private persistSession(): void {
    const messages = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    void this.memento.update("wright.session", {
      items: this.items.slice(-200),
      messages: messages.slice(-100),
      model: this.model,
    });
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
    this.pendingPlan = undefined;
    this.savedMessages = undefined;
    this.items = [];
    this.persistSession();
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
      planPending: this.pendingPlan !== undefined,
      approvalMode: this.approvalMode,
      sessionStats: this.formatSessionStats(),
    });
  }

  private formatSessionStats(): string | undefined {
    const { input, output } = this.sessionUsage;
    if (input + output === 0) return undefined;
    const config = getConfig();
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    let stats = `session: ${fmt(input)}↑ ${fmt(output)}↓`;
    if (config.priceInPer1M > 0 || config.priceOutPer1M > 0) {
      const usd = (input / 1e6) * config.priceInPer1M + (output / 1e6) * config.priceOutPer1M;
      stats += ` · ~$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
    }
    return stats;
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
      case "setApprovalMode":
        this.approvalMode = msg.mode;
        void vscode.workspace.getConfiguration("wright").update("approvalMode", msg.mode);
        return;
      case "send":
        if (this.pendingPlan) {
          // Typing while a plan awaits approval = revision feedback.
          await this.handlePlan(this.pendingPlan.task, msg.text);
        } else if (msg.planFirst) {
          await this.handlePlan(msg.text);
        } else {
          await this.handleSend(msg.text);
        }
        return;
      case "executePlan": {
        const pending = this.pendingPlan;
        this.pendingPlan = undefined;
        this.sendState(false);
        if (pending) await this.handleSend(executionMessage(pending.task, pending.plan), { displayText: "▶ Execute plan" });
        return;
      }
      case "discardPlan":
        this.pendingPlan = undefined;
        this.items.push({ kind: "text", role: "assistant", content: "_Plan discarded._" });
        this.sendState(false);
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
    const rules = await loadRulesFile(root.fsPath);
    const agent = new Agent({
      client,
      model: this.model,
      tools,
      systemPrompt: agentSystemPrompt({ workspaceName: vscode.workspace.name, rules }),
      approve: async (name, args) => {
        const decision = new ApprovalPolicy({ mode: this.approvalMode }).decide(name, args);
        if (decision.action === "allow") return true;
        const detail = name === "run_command" ? String(args.command ?? "") : `${name} → ${String(args.path ?? "")}`;
        const why = decision.reason ? ` (${decision.reason})` : "";
        const choice = await vscode.window.showWarningMessage(
          `Wright wants to run: ${detail}${why}`,
          { modal: true },
          "Allow",
        );
        return choice === "Allow";
      },
    });
    // Rehydrate a persisted conversation into the fresh agent (Phase 10).
    if (this.savedMessages?.length) {
      agent.restoreHistory(this.savedMessages);
      this.savedMessages = undefined;
    }
    return agent;
  }

  /** Composer: draft (or revise) a plan and hold it for approval. */
  private async handlePlan(task: string, feedback?: string): Promise<void> {
    if (this.abort) return;
    const config = getConfig();
    if (!config.apiKey) {
      this.post({ type: "error", message: "No NVIDIA API key found. Set `wright.nvidia.apiKey` in Settings." });
      return;
    }
    const root = workspaceRoot();
    if (!root) {
      this.post({ type: "error", message: "Open a folder first — the composer needs a workspace." });
      return;
    }

    const priorPlan = feedback ? this.pendingPlan?.plan : undefined;
    this.pendingPlan = undefined;
    this.items.push({ kind: "text", role: "user", content: feedback ?? task });
    this.sendState(true);

    const client = new ModelClient(nvidiaProvider({ apiKey: config.apiKey, chatModel: this.model }));
    this.abort = new AbortController();
    const planItem: Extract<UiItem, { kind: "text" }> = { kind: "text", role: "assistant", content: "" };
    this.items.push(planItem);
    this.post({ type: "assistantStart" });

    try {
      const indexer = await this.indexService.ensure(client, root.fsPath);
      const context = indexer ? await planContext(indexer, task, this.abort.signal) : undefined;
      const plan = await generatePlan(
        client,
        this.model,
        { task, context, priorPlan, feedback },
        {
          signal: this.abort.signal,
          onEvent: (e) => {
            if (e.type === "text") {
              planItem.content += e.text;
              this.post({ type: "delta", text: e.text });
            }
          },
        },
      );
      this.pendingPlan = { task, plan };
      this.post({ type: "turnDone" });
      this.post({ type: "planReady" });
    } catch (err) {
      if (err instanceof ModelError && err.kind === "aborted") {
        this.post({ type: "turnDone", stats: "cancelled" });
      } else {
        this.post({ type: "error", message: err instanceof ModelError ? err.message : String(err) });
        this.post({ type: "turnDone" });
      }
    } finally {
      this.abort = undefined;
      this.sendState(false);
    }
  }

  private async handleSend(text: string, opts: { displayText?: string } = {}): Promise<void> {
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

    this.items.push({ kind: "text", role: "user", content: opts.displayText ?? text });
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
            this.sessionUsage.input += event.usage.prompt_tokens;
            this.sessionUsage.output += event.usage.completion_tokens;
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
      this.persistSession();
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
