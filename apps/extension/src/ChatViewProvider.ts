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
  createWebSearchTool,
  executionMessage,
  generatePlan,
  nvidiaProvider,
  planContext,
} from "@wright/core";
import { NodeWorkspaceHost, connectMcpServers, loadRulesFile, type McpConnection, type McpServerConfig } from "@wright/core/node";
import { IndexService } from "./IndexService.js";
import { getConfig } from "./config.js";
import { getActiveFile, workspaceRoot } from "./workspace.js";
import type { ChatMode, FileAttachment, HostToWebview, ResearchMode, UiItem, WebviewToHost } from "./protocol.js";
import type { AgentMode } from "@wright/core";

/** Virtual document scheme serving pre-edit snapshots for the diff editor. */
export const ORIGINAL_SCHEME = "wright-original";


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
  /** MCP connections (Phase 11), established once per window. */
  private mcp: McpConnection | undefined;
  private mcpAttempted = false;
  /** What the current agent was built for; a mismatch forces a rebuild. */
  private agentBuiltFor: { model: string; mode: AgentMode; research: ResearchMode } | undefined;
  /** Cached workspace file list for the @-mention picker. */
  private fileListCache: { entries: Array<{ path: string; type: "file" | "dir" }>; at: number } | undefined;
  /** A big-looking agent task parked while the user decides Plan vs Agent. */
  private pendingSuggest: { text: string; images?: string[]; files?: FileAttachment[]; research: ResearchMode } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexService: IndexService,
    /** Workspace-scoped persistence for chat sessions (Phase 10). */
    private readonly memento: vscode.Memento,
  ) {
    this.model = "auto"; // routes per task: fast for Ask, vision for images, strong for agent work
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

  /** Editor context menu: attach the selection to the composer as reference. */
  async addSelectionToChat(): Promise<void> {
    const info = getActiveFile();
    if (!info?.selection) {
      vscode.window.showInformationMessage("Wright: select some code first.");
      return;
    }
    await this.ensureViewOpen();
    const name = `${info.path.split("/").pop()}:${info.selection.startLine}-${info.selection.endLine}`;
    this.post({
      type: "attachSelection",
      file: { name, content: `// ${info.path} (lines ${info.selection.startLine}-${info.selection.endLine})\n${info.selection.text}` },
    });
  }

  /** Editor context menu: one-shot Explain / Review on the selection (Ask mode). */
  async runSelectionAction(action: "explain" | "review"): Promise<void> {
    const info = getActiveFile();
    if (!info?.selection) {
      vscode.window.showInformationMessage("Wright: select some code first.");
      return;
    }
    await this.ensureViewOpen();
    const where = `${info.path}:${info.selection.startLine}-${info.selection.endLine}`;
    const instruction =
      action === "explain"
        ? `Explain the following code from ${where}. Cover what it does, how, and anything non-obvious:`
        : `Review the following code from ${where}. Look for bugs, edge cases, and concrete improvements — be specific and cite lines:`;
    await this.handleSend(`${instruction}\n\`\`\`${info.languageId}\n${info.selection.text}\n\`\`\``, {
      mode: "ask",
      displayText: `${action === "explain" ? "Explain" : "Review"} ${where}`,
    });
  }

  private async ensureViewOpen(): Promise<void> {
    if (this.view) return;
    await vscode.commands.executeCommand("wright.chat.focus");
    // Give the webview a beat to resolve and announce ready.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  newChat(): void {
    this.abort?.abort();
    this.agent = undefined;
    this.agentBuiltFor = undefined;
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
    const config = getConfig();
    const models = ["auto", ...config.modelList];
    if (!models.includes(this.model)) models.splice(1, 0, this.model);
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
      defaultMode: config.defaultMode,
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
        this.agentBuiltFor = undefined; // next turn rebuilds on the new model
        return;
      case "setApprovalMode":
        this.approvalMode = msg.mode;
        void vscode.workspace.getConfiguration("wright").update("approvalMode", msg.mode);
        return;
      case "send":
        if (this.pendingPlan && !msg.images?.length) {
          // Typing while a plan awaits approval = revision feedback.
          await this.handlePlan(this.pendingPlan.task, msg.text);
        } else if (msg.mode === "plan" && !msg.images?.length) {
          await this.handlePlan(msg.text);
        } else {
          const mode: AgentMode = msg.mode === "plan" || msg.mode === "agent" ? "agent" : msg.mode;
          // Big-task detection (agent mode only): offer to plan first.
          if (mode === "agent" && msg.mode === "agent" && !msg.images?.length && (await this.looksLikeBigTask(msg.text))) {
            this.pendingSuggest = { text: msg.text, images: msg.images, files: msg.files, research: msg.research };
            this.items.push({ kind: "text", role: "user", content: msg.text, files: msg.files?.map((f) => f.name) });
            this.post({ type: "planSuggest" });
            this.sendState(false);
            return;
          }
          await this.handleSend(msg.text, { images: msg.images, files: msg.files, mode, research: msg.research });
        }
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "wright");
        return;
      case "planDecision": {
        const parked = this.pendingSuggest;
        this.pendingSuggest = undefined;
        if (!parked) return;
        if (msg.usePlan) {
          // The user message is already in the transcript; plan without re-adding it.
          this.items.pop();
          await this.handlePlan(parked.text);
        } else {
          await this.handleSend(parked.text, { ...parked, mode: "agent", skipUserItem: true });
        }
        return;
      }
      case "queryFiles":
        await this.handleQueryFiles(msg.query, msg.token);
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

  /**
   * Is this request big enough that planning first would help? Cheap
   * word-count/keyword gate first; only genuinely ambiguous ones spend a
   * ~1s fast-model classification. Fails open (false) on any error.
   */
  private async looksLikeBigTask(text: string): Promise<boolean> {
    const words = text.trim().split(/\s+/).length;
    if (words < 12) return false;
    const bigSignals = /(build|create|implement|design|make)\b.{0,40}\b(app|application|project|website|system|dashboard|platform|feature|page|screen)|entire|whole|full[- ]?(stack|project|app)|from scratch|multiple|several|redesign|overhaul/i;
    if (words > 120) return true;
    if (!bigSignals.test(text)) return false;
    const config = getConfig();
    if (!config.apiKey) return false;
    try {
      const client = new ModelClient(nvidiaProvider({ apiKey: config.apiKey, chatModel: config.fastModel }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const result = await client.complete(
        {
          model: config.fastModel,
          messages: [
            {
              role: "system",
              content:
                "Classify the coding request. Reply with exactly one word. " +
                "BIG = building a whole app/project, a feature spanning many files, or several distinct tasks. " +
                "SMALL = a focused change, single file, bug fix, or question.",
            },
            { role: "user", content: text.slice(0, 2_000) },
          ],
          max_tokens: 300,
          temperature: 0,
        },
        { signal: controller.signal, retry: { maxAttempts: 1 } },
      );
      clearTimeout(timer);
      return /\bBIG\b/i.test(result.message.content ?? "");
    } catch {
      return false;
    }
  }

  /** Resolve "auto" to a concrete model for this turn (Phase 10 routing). */
  private resolveModel(mode: AgentMode, hasImages: boolean): string {
    const config = getConfig();
    if (hasImages) return config.visionModel;
    if (this.model !== "auto") return this.model;
    return mode === "ask" ? config.fastModel : config.chatModel;
  }

  private async handleQueryFiles(query: string, token: number): Promise<void> {
    if (!this.fileListCache || Date.now() - this.fileListCache.at > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,build,coverage}/**", 3_000);
      const files = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      this.fileListCache = {
        at: Date.now(),
        entries: [
          ...[...dirs].sort().map((d) => ({ path: d, type: "dir" as const })),
          ...files.map((f) => ({ path: f, type: "file" as const })),
        ],
      };
    }
    const q = query.toLowerCase();
    const scored = this.fileListCache.entries
      .filter((e) => !q || e.path.toLowerCase().includes(q))
      .sort((a, b) => {
        // Basename matches beat path matches; shorter paths beat longer.
        const aBase = a.path.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        const bBase = b.path.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        return aBase - bBase || a.path.length - b.path.length;
      })
      .slice(0, 25);
    this.post({ type: "fileList", token, entries: scored });
  }

  private async buildAgent(apiKey: string, model: string, mode: AgentMode, research: ResearchMode): Promise<Agent> {
    const root = workspaceRoot();
    if (!root) throw new Error("Open a folder first — Wright's agent needs a workspace to work in.");
    const config = getConfig();
    const client = new ModelClient(
      nvidiaProvider({ apiKey, chatModel: model, fastModel: config.fastModel }),
    );
    this.tracker ??= new TrackedHost(new NodeWorkspaceHost(root.fsPath));
    let tools = createBuiltinTools(this.tracker);
    const indexer = await this.indexService.ensure(client, root.fsPath);
    if (indexer) tools.push(createCodebaseSearchTool(indexer));
    tools.push(createWebSearchTool(config.webSearch));
    if (mode === "ask") {
      const readOnly = new Set(["read_file", "list_dir", "search", "codebase_search", "web_search"]);
      tools = tools.filter((t) => readOnly.has(t.definition.function.name));
    }
    const rules = await loadRulesFile(root.fsPath);

    // MCP tool servers (Phase 11), from wright.mcp.servers.
    if (!this.mcpAttempted) {
      this.mcpAttempted = true;
      const servers = vscode.workspace.getConfiguration("wright").get<Record<string, McpServerConfig>>("mcp.servers") ?? {};
      if (Object.keys(servers).length > 0) {
        this.mcp = await connectMcpServers(servers, {
          onError: (server, err) =>
            vscode.window.showWarningMessage(`Wright: MCP server "${server}" failed to start: ${String(err).slice(0, 120)}`),
        });
        const total = this.mcp.tools.length;
        if (total > 0) vscode.window.setStatusBarMessage(`Wright: ${total} MCP tool(s) connected`, 5_000);
      }
    }
    if (this.mcp) tools.push(...this.mcp.tools);

    const agent = new Agent({
      client,
      model,
      tools,
      // Deep research fans out into many search rounds; give it headroom.
      maxIterations: research === "deep" ? 60 : research === "research" ? 40 : 25,
      systemPrompt: agentSystemPrompt({ workspaceName: vscode.workspace.name, rules, mode, research }),
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

    const planModel = this.model === "auto" ? config.chatModel : this.model;
    const client = new ModelClient(nvidiaProvider({ apiKey: config.apiKey, chatModel: planModel }));
    this.abort = new AbortController();
    const planItem: Extract<UiItem, { kind: "text" }> = { kind: "text", role: "assistant", content: "" };
    this.items.push(planItem);
    this.post({ type: "assistantStart" });

    try {
      const indexer = await this.indexService.ensure(client, root.fsPath);
      const context = indexer ? await planContext(indexer, task, this.abort.signal) : undefined;
      const plan = await generatePlan(
        client,
        planModel,
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

  private async handleSend(
    text: string,
    opts: { displayText?: string; images?: string[]; files?: FileAttachment[]; mode?: AgentMode; research?: ResearchMode; skipUserItem?: boolean } = {},
  ): Promise<void> {
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

    const mode = opts.mode ?? "agent";
    const research = opts.research ?? "off";
    const resolvedModel = this.resolveModel(mode, (opts.images?.length ?? 0) > 0);
    try {
      if (
        !this.agent ||
        this.agentBuiltFor?.model !== resolvedModel ||
        this.agentBuiltFor.mode !== mode ||
        this.agentBuiltFor.research !== research
      ) {
        // Carry the conversation across model/mode/research switches.
        if (this.agent) this.savedMessages = [...this.agent.history];
        this.agent = await this.buildAgent(config.apiKey, resolvedModel, mode, research);
        this.agentBuiltFor = { model: resolvedModel, mode, research };
      }
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (!opts.skipUserItem) {
      this.items.push({
        kind: "text",
        role: "user",
        content: opts.displayText ?? text,
        images: opts.images,
        files: opts.files?.map((f) => f.name),
      });
    }
    this.sendState(true);
    text = await this.expandMentions(text);
    text = await this.expandAttachments(text, opts.files);

    this.abort = new AbortController();
    const start = Date.now();
    let currentText: Extract<UiItem, { kind: "text" }> | undefined;
    let currentThinking: Extract<UiItem, { kind: "thinking" }> | undefined;
    let thinkingStart = 0;
    const endThinking = () => {
      if (!currentThinking) return;
      currentThinking.seconds = Math.round((Date.now() - thinkingStart) / 1000);
      this.post({ type: "thinkingDone", seconds: currentThinking.seconds });
      currentThinking = undefined;
    };

    try {
      for await (const event of this.agent.run(text, { signal: this.abort.signal, images: opts.images })) {
        switch (event.type) {
          case "reasoning":
            if (!currentThinking) {
              currentThinking = { kind: "thinking", content: "", seconds: 0 };
              thinkingStart = Date.now();
              this.items.push(currentThinking);
              currentText = undefined;
            }
            currentThinking.content += event.text;
            this.post({ type: "thinkingDelta", text: event.text });
            break;
          case "text":
            endThinking();
            if (!currentText) {
              currentText = { kind: "text", role: "assistant", content: "" };
              this.items.push(currentText);
              this.post({ type: "assistantStart" });
            }
            currentText.content += event.text;
            this.post({ type: "delta", text: event.text });
            break;
          case "tool_start": {
            endThinking();
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
            endThinking();
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
      // Optional hands-off mode: accept every edit as soon as the turn ends.
      if (getConfig().autoKeep) this.tracker?.keepAll();
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
    const mentions = [...text.matchAll(/@([\w@./\\-]+)/g)].map((m) => m[1]!.replace(/\/$/, ""));
    const attachments: string[] = [];
    for (const rel of new Set(mentions)) {
      try {
        const content = await this.tracker.readFile(rel);
        attachments.push(`\n\n[Attached file @${rel}]\n\`\`\`\n${content.slice(0, 16_000)}\n\`\`\``);
      } catch {
        // Not a file — maybe a folder: attach its listing so the agent can dig in.
        try {
          const entries = await this.tracker.listDir(rel);
          const listing = entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).join("\n");
          attachments.push(`\n\n[Attached folder @${rel} — contents]\n${listing.slice(0, 4_000)}`);
        } catch {
          // neither — leave the token as plain text
        }
      }
    }
    return attachments.length > 0 ? text + attachments.join("") : text;
  }

  /** Files attached via drag & drop or the paperclip (Cursor-style reference context). */
  private async expandAttachments(text: string, files?: FileAttachment[]): Promise<string> {
    if (!files || files.length === 0) return text;
    const blocks: string[] = [];
    for (const file of files) {
      let content = file.content;
      if (content === undefined && file.path && this.tracker) {
        try {
          content = await this.tracker.readFile(file.path);
        } catch {
          content = undefined;
        }
      }
      if (content !== undefined) {
        blocks.push(`\n\n[Attached file: ${file.path ?? file.name}]\n\`\`\`\n${content.slice(0, 16_000)}\n\`\`\``);
      }
    }
    return blocks.length > 0 ? text + blocks.join("") : text;
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
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
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
