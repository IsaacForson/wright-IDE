import * as vscode from "vscode";
import {
  Agent,
  ApprovalPolicy,
  ContextBudget,
  ModelClient,
  ModelError,
  PROVIDER_CATALOG,
  TrackedHost,
  CheckpointManager,
  agentSystemPrompt,
  estimateConversationTokens,
  parseModelRef,
  type ApprovalMode,
  type ChatMessage,
  createBuiltinTools,
  createAskUserTool,
  createCodebaseSearchTool,
  createReadUrlTool,
  createWebSearchTool,
  createRememberTool,
  memoriesBlock,
  type MemoryStore,
  executionMessage,
  executionMessageFromSteps,
  parsePlanSteps,
  formatModelRef,
  generatePlan,
  nvidiaProvider,
  planContext,
  type AskUserPayload,
} from "@wright/core";
import { NodeWorkspaceHost, connectMcpServers, loadRulesFile, type McpConnection, type McpServerConfig } from "@wright/core/node";
import { IndexService } from "./IndexService.js";
import { createDiagnosticsTool } from "./diagnosticsTool.js";
import { createGitHistoryTool } from "./gitHistoryTool.js";
import { FileMemoryStore } from "./memoryStore.js";
import { listWorkflows, expandWorkflow } from "./workflows.js";
import { buildPlanMarkdown, hasUncheckedSteps, isContinueMessage, planSlug } from "./planFile.js";
import { PlanPanel } from "./planPanel.js";
import { TerminalHost } from "./terminalHost.js";
import { DEFAULT_MODEL_LIST, getConfig } from "./config.js";
import { RECOMMENDED_LOCAL_MODELS, deleteModel, ensureOllamaRunning, listLocalModels, offerOllamaInstall, pullModel } from "./ollama.js";
import { buildFailoverClient, buildPickerModels, getCloudProviders, hasAnyCloudCredential, pickCouncilModels } from "./providers.js";
import { getActiveFile, workspaceRoot } from "./workspace.js";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMode, FileAttachment, FileChangeItem, HostToWebview, ResearchMode, UiItem, WebviewToHost } from "./protocol.js";
import type { AgentMode } from "@wright/core";

const NO_WORKSPACE_NOTE = `

# No workspace folder is open
You are rooted at the user's HOME directory (~); all paths are relative to it. You can read/explore anything under it and create brand-new projects: ask where the project should live if the user didn't say (e.g. ~/Desktop or ~/Projects), create the folder with your tools, scaffold inside it, and when done tell the user to open it via File → Open Folder for the full experience (indexing, rules, diagnostics).`;

/** Virtual document scheme serving pre-edit snapshots for the diff editor. */
export const ORIGINAL_SCHEME = "wright-original";

/** Keyword signals for a "large" task (shared by big-task detection + auto-router). */
/** Max automatic "continue" turns per user task (each allows up to 25 steps). */
const AUTO_CONTINUE_MAX = 5;

const BIG_TASK_SIGNALS =
  /(build|create|implement|design|make)\b.{0,40}\b(app|application|project|website|system|dashboard|platform|feature|page|screen)|entire|whole|full[- ]?(stack|project|app)|from scratch|multiple|several|redesign|overhaul/i;

/** Short display name for a model ref (`groq:llama-3.3-70b` → "llama-3.3-70b"). */
function modelShortLabel(ref: string): string {
  const afterProvider = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  return afterProvider.split("/").pop() ?? afterProvider;
}

/** Cheap synchronous "is this a big task?" for model routing (no model call). */
function isBigTaskHeuristic(text: string): boolean {
  const words = text.trim().split(/\s+/).length;
  if (words > 120) return true;
  if (words < 12) return false;
  return BIG_TASK_SIGNALS.test(text);
}

/** Does any path in this turn (attachments or @-mentions) match a sensitive glob? */
function turnTouchesSensitiveImpl(text: string, files: string[], globs: string[]): boolean {
  if (globs.length === 0) return false;
  const res = globs.map((g) => {
    const rx = g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, " ")
      .replace(/\*/g, "[^/]*")
      .replace(/ /g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`(^|/)${rx}$|^${rx}$`, "i");
  });
  const mentions = [...text.matchAll(/@([\w./\-]+)/g)].map((m) => m[1]!.replace(/\/$/, ""));
  const candidates = [...files, ...mentions];
  return candidates.some((p) => res.some((rx) => rx.test(p) || rx.test(p.split("/").pop() ?? p)));
}

/** One persisted chat in workspaceState (30-day retention). */
interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  items: UiItem[];
  messages: ChatMessage[];
  model: string;
}


export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "wright.chat";

  private view: vscode.WebviewView | undefined;
  private agent: Agent | undefined;
  private tracker: TrackedHost | undefined;
  /** Per-turn restore points (created lazily alongside the tracker). */
  private checkpoints: CheckpointManager | undefined;
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
  private agentBuiltFor: { model: string; mode: AgentMode; research: ResearchMode; forceLocal: boolean } | undefined;
  /** Cached workspace file list for the @-mention picker. */
  private fileListCache: { entries: Array<{ path: string; type: "file" | "dir" }>; at: number } | undefined;
  /** Where the tracker/tools are rooted: the workspace, or ~ when none is open. */
  private rootPath: string | undefined;
  /** Project memory store, created with the tracker. */
  private memoryStore: MemoryStore = new FileMemoryStore(os.homedir());
  /** Installed Ollama models, refreshed opportunistically for the picker. */
  private localModels: string[] = [];
  /** A big-looking agent task parked while the user decides Plan vs Agent. */
  private pendingSuggest: { text: string; images?: string[]; files?: FileAttachment[]; research: ResearchMode } | undefined;
  /** In-flight ask_user tool — resolved when the webview submits picks. */
  private pendingAsk:
    | { id: string; resolve: (text: string) => void; reject: (err: Error) => void }
    | undefined;
  /** In-chat permission card — resolved when the user picks Allow Always / Once / Always Ask. */
  private pendingPermission:
    | {
        id: string;
        resolve: (decision: "allow-always" | "allow-once" | "always-ask" | "deny") => void;
        reject: (err: Error) => void;
      }
    | undefined;
  /**
   * Session trust from the permission card:
   * - admin: allow everything without asking (Allow Always)
   * - session: allow for this chat session (Allow Once)
   */
  private sessionTrust: "admin" | "session" | undefined;
  /** Shell host used for agent commands + manual re-runs. */
  private commandHost: TerminalHost | undefined;
  /** Tool id currently streaming command output. */
  private liveCommandId: string | undefined;
  /** Preferred run target (IDE terminal vs sandbox). */
  private commandRunTarget: "terminal" | "sandbox" = "terminal";
  /** Settings → Permissions → In-chat permission default. */
  private permissionDefault: "always-ask" | "allow-once" | "allow-always" = "always-ask";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexService: IndexService,
    /** Workspace-scoped persistence for chat sessions (Phase 10). */
    private readonly memento: vscode.Memento,
  ) {
    this.model = "auto"; // routes per task: fast for Ask, vision for images, strong for agent work
    this.approvalMode = getConfig().approvalMode;
    this.commandRunTarget = getConfig().commandRunTarget;
    this.permissionDefault = getConfig().permissionDefault;
    this.applyPermissionDefault();
    this.restoreSession();
  }

  /** Apply Settings → Permissions default to session trust. */
  private applyPermissionDefault(): void {
    if (this.permissionDefault === "allow-always") {
      this.sessionTrust = "admin";
    } else if (this.permissionDefault === "allow-once") {
      this.sessionTrust = "session";
    } else {
      this.sessionTrust = undefined;
    }
  }

  // ── Session persistence & history (Phase 10) ─────────────────────────
  // All chats live in workspaceState under "wright.sessions"; anything
  // untouched for 30 days is pruned on load. Capped at 40 sessions.

  private sessionId = `s${Date.now().toString(36)}`;

  /** Agent history to restore once the agent is first built this session. */
  private savedMessages: ChatMessage[] | undefined;
  /** Prompts the user queued while a turn was running; drained in order. */
  private promptQueue: Array<{ id: string; msg: Extract<WebviewToHost, { type: "send" }> }> = [];
  private queueSeq = 0;
  /** Iteration cap of the current agent (mirrors buildAgent's maxIterations). */
  private agentMaxIterations = 25;
  /** Consecutive automatic continues for one user task. */
  private autoContinues = 0;
  /** How the last agent turn ended — inputs for the unfinished-work detector. */
  private lastTurnEnd: { capHit: boolean; finalText: string } | undefined;
  /** True while an executed plan's file may still have open steps. */
  private planFileActive = false;
  /** The plan document being executed right now. */
  private currentPlanUri: vscode.Uri | undefined;
  private currentPlanRel: string | undefined;

  private loadSessions(): StoredSession[] {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return (this.memento.get<StoredSession[]>("wright.sessions") ?? []).filter((s) => s.updatedAt > cutoff);
  }

  private restoreSession(): void {
    const sessions = this.loadSessions();
    void this.memento.update("wright.sessions", sessions); // persist the prune
    const currentId = this.memento.get<string>("wright.currentSession");
    const session = sessions.find((s) => s.id === currentId) ?? sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!session || session.items.length === 0) return;
    this.sessionId = session.id;
    this.items = session.items;
    this.model = session.model || this.model;
    this.savedMessages = session.messages;
  }

  private persistSession(): void {
    if (this.items.length === 0) return;
    const messages = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    const firstUser = this.items.find((i) => i.kind === "text" && i.role === "user");
    const title = (firstUser?.kind === "text" ? firstUser.content : "").replace(/\s+/g, " ").slice(0, 60) || "New chat";
    const sessions = this.loadSessions().filter((s) => s.id !== this.sessionId);
    sessions.unshift({
      id: this.sessionId,
      title,
      updatedAt: Date.now(),
      items: this.items.slice(-200),
      messages: messages.slice(-100),
      model: this.model,
    });
    void this.memento.update("wright.sessions", sessions.slice(0, 40));
    void this.memento.update("wright.currentSession", this.sessionId);
  }

  private sendSessions(): void {
    const sessions = this.loadSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, current: s.id === this.sessionId }));
    this.post({ type: "sessions", sessions });
  }

  private switchSession(id: string): void {
    if (id === this.sessionId) return;
    this.persistSession();
    const session = this.loadSessions().find((s) => s.id === id);
    if (!session) return;
    this.abort?.abort();
    this.sessionId = session.id;
    this.items = session.items;
    this.model = session.model || this.model;
    this.savedMessages = session.messages;
    this.agent = undefined;
    this.agentBuiltFor = undefined;
    this.pendingPlan = undefined;
    void this.memento.update("wright.currentSession", this.sessionId);
    this.sendState(false);
  }

  private deleteSession(id: string): void {
    void this.memento.update("wright.sessions", this.loadSessions().filter((s) => s.id !== id));
    if (id === this.sessionId) {
      this.items = [];
      this.savedMessages = undefined;
      this.agent = undefined;
      this.agentBuiltFor = undefined;
      this.sessionId = `s${Date.now().toString(36)}`;
      this.sendState(false);
    }
    this.sendSessions();
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
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wright")) {
        const config = getConfig();
        this.approvalMode = config.approvalMode;
        this.commandRunTarget = config.commandRunTarget;
        this.permissionDefault = config.permissionDefault;
        if (this.commandHost) this.commandHost.target = this.commandRunTarget;
        // Only re-apply trust from settings when not mid-turn (don't yank a live allow).
        if (!this.abort) this.applyPermissionDefault();
        this.agent = undefined;
        this.agentBuiltFor = undefined;
        this.sendState(this.abort !== undefined);
      }
    });
    view.onDidDispose(() => configSub.dispose());
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

  /** Explorer / command: attach file or folder URIs to the composer. */
  async addUrisToChat(uris?: readonly vscode.Uri[]): Promise<void> {
    if (!uris?.length) {
      await this.pickAttachments();
      return;
    }
    await this.ensureViewOpen();
    await this.handleResolveDrops(uris.map((u) => u.toString(true)));
  }

  /** Paperclip: native file/folder picker (reliable — VS Code blocks webview drops without Shift). */
  async pickAttachments(): Promise<void> {
    await this.ensureViewOpen();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: "Attach to Wright",
      defaultUri: workspaceRoot(),
    });
    if (!uris?.length) return;
    await this.handleResolveDrops(uris.map((u) => u.toString(true)));
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

  /** Tracker + checkpoint manager, created once and rooted at `root`. */
  private ensureTracker(root: string): TrackedHost {
    if (!this.tracker) {
      this.tracker = new TrackedHost(new NodeWorkspaceHost(root));
      this.checkpoints = new CheckpointManager(this.tracker);
    }
    return this.tracker;
  }

  newChat(): void {
    this.abort?.abort();
    this.persistSession(); // park the old conversation in history
    this.agent = undefined;
    this.agentBuiltFor = undefined;
    // Changes stay on disk; starting a new chat just stops tracking them.
    this.tracker = undefined;
    this.checkpoints = undefined;
    this.commandHost = undefined;
    this.liveCommandId = undefined;
    if (this.pendingPermission) {
      this.pendingPermission.reject(new ModelError("aborted", "Chat cleared"));
      this.pendingPermission = undefined;
    }
    this.applyPermissionDefault();
    this.pendingPlan = undefined;
    this.savedMessages = undefined;
    this.planFileActive = false;
    this.currentPlanUri = undefined;
    this.currentPlanRel = undefined;
    this.autoContinues = 0;
    this.promptQueue = [];
    this.postQueue();
    this.items = [];
    this.sessionId = `s${Date.now().toString(36)}`;
    this.sendState(false);
    // Reset webview-local UI (history overlay, mode picker) to match the fresh chat.
    this.post({ type: "chatCleared" });
  }

  /** Rewind the workspace + conversation to a per-turn checkpoint. */
  private async restoreCheckpoint(id: string): Promise<void> {
    if (!this.checkpoints || this.abort) {
      if (this.abort) vscode.window.showInformationMessage("Wright: stop the current turn before restoring.");
      return;
    }
    const truncateTo = await this.checkpoints.restore(id);
    if (truncateTo === undefined) return;
    this.items = this.items.slice(0, truncateTo);
    await this.tracker?.reconcile();
    // Rebuild the agent's context from the surviving text turns (tool calls
    // are dropped, but the textual conversation is preserved).
    this.savedMessages = this.items
      .filter((i): i is Extract<UiItem, { kind: "text" }> => i.kind === "text")
      .map((i) => ({ role: i.role, content: i.content }));
    this.agent = undefined;
    this.agentBuiltFor = undefined;
    this.pendingPlan = undefined;
    vscode.window.setStatusBarMessage("Wright: rewound to checkpoint", 4_000);
    this.sendState(false);
    this.sendChanges();
  }

  /**
   * Model Council: ask 1-2 OTHER models the same question as the last turn
   * and show their answers beside the original for comparison. Chat-only
   * (no tools/edits) — a second opinion, not a parallel agent run.
   */
  private async runSecondOpinion(): Promise<void> {
    if (this.abort) return;
    const history = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    // Drop trailing assistant turn(s) so the alternates answer the same prompt.
    const msgs = [...history];
    while (msgs.length && msgs.at(-1)!.role !== "user") msgs.pop();
    if (msgs.length === 0) {
      vscode.window.showInformationMessage("Wright: nothing to get a second opinion on yet.");
      return;
    }
    const lastUser = msgs.at(-1);
    const question = typeof lastUser?.content === "string" ? lastUser.content.slice(0, 100) : "the last question";
    const refs = pickCouncilModels(this.model, 2);
    if (refs.length === 0) {
      vscode.window.showInformationMessage("Wright: add a second provider/model to compare against (Settings → Providers).");
      return;
    }

    const councilItem: Extract<UiItem, { kind: "council" }> = { kind: "council", status: "running", question, answers: [] };
    this.items.push(councilItem);
    this.sendState(true);

    const results = await Promise.all(
      refs.map(async (ref) => {
        try {
          const { client, agentModel } = await buildFailoverClient(ref, { forceLocal: getConfig().offlineMode });
          const res = await client.complete({
            model: agentModel,
            messages: [
              { role: "system", content: "You are a senior engineer giving a concise second opinion. Answer the user's last question directly; note if you'd approach it differently." },
              ...msgs.filter((m) => m.role === "user" || m.role === "assistant"),
            ],
            max_tokens: 2_048,
          });
          return { label: modelShortLabel(ref), text: res.message.content ?? "(no answer)" };
        } catch (err) {
          return { label: modelShortLabel(ref), text: `⚠︎ ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    );
    councilItem.answers = results;
    councilItem.status = "done";
    this.persistSession();
    this.sendState(false);
  }

  /** View & prune project memories (Cursor/Windsurf-style Memories manager). */
  async manageMemories(): Promise<void> {
    const entries = await this.memoryStore.list();
    if (entries.length === 0) {
      vscode.window.showInformationMessage("Wright: no memories yet. The agent saves durable project facts as it learns them (stored in .wright/memories.json).");
      return;
    }
    const trash = new vscode.ThemeIcon("trash");
    const qp = vscode.window.createQuickPick();
    qp.title = "Wright: project memories — 🗑 to forget one";
    qp.items = entries.map((e) => ({ label: e.text, buttons: [{ iconPath: trash, tooltip: "Forget" }] }));
    qp.onDidTriggerItemButton(async (ev) => {
      const entry = entries.find((e) => e.text === ev.item.label);
      if (entry) {
        await this.memoryStore.remove(entry.id);
        this.agentBuiltFor = undefined; // reload memories into the next agent
        vscode.window.setStatusBarMessage("Wright: forgot a memory", 3_000);
        void this.manageMemories();
        qp.hide();
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  /**
   * ▶ Build from the Plan panel: hand the plan file to the agent — resume its
   * unchecked steps. Queues if a turn is already running.
   */
  buildPlan(uri: vscode.Uri, relPath: string): void {
    this.currentPlanUri = uri;
    this.currentPlanRel = relPath;
    this.planFileActive = true;
    this.autoContinues = 0;
    const text =
      `Execute the plan document at ${relPath}. Read it first; then work through every unchecked "- [ ]" step in order, ` +
      `ticking each to "- [x]" with edit_file immediately after completing it. Follow the plan's Architecture and Tradeoffs sections. ` +
      `Do NOT write a new plan — this one is approved. Finish with the plan's Verification step.`;
    if (this.abort) {
      this.enqueuePrompt({ type: "send", text, mode: "agent", research: "off" });
    } else {
      void this.handleSend(text, { displayText: "▶ Build plan", mode: "agent" });
    }
  }

  /** Changes shown in the panel — hides .wright/ internals (live plan ticks). */
  private visibleChanges(): FileChangeItem[] {
    return (this.tracker?.changes() ?? []).filter((c) => !c.path.startsWith(".wright/"));
  }

  /**
   * Write a Cursor-style plan document to .wright/plans/<slug>.md and open it
   * in the RENDERED markdown preview (live-updates as the agent ticks steps).
   * Returns the workspace-relative path, or undefined when nothing was written.
   */
  private async writePlanFile(task: string, steps: string[], planBody?: string): Promise<string | undefined> {
    const root = this.rootPath ?? workspaceRoot()?.fsPath;
    if (!root || steps.length === 0) return undefined;
    try {
      const dir = vscode.Uri.joinPath(vscode.Uri.file(root), ".wright", "plans");
      await vscode.workspace.fs.createDirectory(dir);
      const now = new Date();
      const file = vscode.Uri.joinPath(dir, `${planSlug(task, now)}.md`);
      await vscode.workspace.fs.writeFile(file, Buffer.from(buildPlanMarkdown(task, steps, now, planBody), "utf8"));
      this.currentPlanUri = file;
      this.currentPlanRel = `.wright/plans/${file.path.split("/").pop()}`;
      // Wright's own plan viewer (real checkboxes, progress bar, live updates
      // from disk) — VS Code's markdown preview renders task lists as literal
      // "[ ]" text and themes everything blue, so we don't use it.
      await PlanPanel.show(file, this.currentPlanRel);
      return this.currentPlanRel;
    } catch {
      return undefined;
    }
  }

  /** Scaffold a new reusable workflow (.wright/workflows/<name>.md) and open it. */
  async newWorkflow(): Promise<void> {
    const root = this.rootPath ?? workspaceRoot()?.fsPath;
    if (!root) {
      vscode.window.showWarningMessage("Wright: open a folder to create a workflow.");
      return;
    }
    const raw = await vscode.window.showInputBox({
      title: "New Wright workflow",
      prompt: "Name (used as /command in the composer)",
      placeHolder: "e.g. add-endpoint",
      validateInput: (v) => (/^[\w-]+$/.test(v.trim()) ? undefined : "Use letters, numbers, dashes only."),
    });
    const name = raw?.trim();
    if (!name) return;
    const dir = vscode.Uri.joinPath(vscode.Uri.file(root), ".wright", "workflows");
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `${name}.md`);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      exists = false;
    }
    if (!exists) {
      const template = `# ${name}\n\nDescribe what this workflow does in one line above (shown in the / picker).\n\nSteps for the agent to follow:\n1. \n2. \n3. \n\nUse the run input (anything typed after /${name}) as the target of these steps.\n`;
      await vscode.workspace.fs.writeFile(file, Buffer.from(template, "utf8"));
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  }

  /** Toggle the chat-history overlay (driven by the native view-title button). */
  toggleHistory(): void {
    this.post({ type: "toggleHistory" });
  }

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  /** Refresh the local-model list and push fresh state when it changes. */
  private refreshLocalModels(): void {
    void listLocalModels().then((list) => {
      const names = list.map((m) => m.name);
      if (JSON.stringify(names) !== JSON.stringify(this.localModels)) {
        this.localModels = names;
        this.sendState(this.abort !== undefined);
      }
    });
  }

  private sendState(busy: boolean): void {
    const config = getConfig();
    const models = buildPickerModels(config.modelList, this.localModels);
    if (!models.includes(this.model)) models.splice(1, 0, this.model);
    const meter = this.contextMeter();
    this.post({
      type: "state",
      items: this.items,
      model: this.model,
      models,
      busy,
      changes: this.visibleChanges(),
      planPending: this.pendingPlan !== undefined,
      approvalMode: this.approvalMode,
      permissionDefault: this.permissionDefault,
      commandRunTarget: this.commandRunTarget,
      sessionStats: this.formatSessionStats(),
      defaultMode: config.defaultMode,
      contextUsage: meter?.usage,
      contextMeterEnabled: meter?.enabled ?? false,
    });
  }

  /** NVIDIA is RPM-limited — no token meter. Cloud/token models get a fill ring. */
  private contextMeterEnabled(): boolean {
    const ref = this.model === "auto" ? getConfig().chatModel : this.model;
    const { providerId } = parseModelRef(ref);
    return providerId !== "nvidia";
  }

  private contextWindowTokens(): number {
    const ref = this.model === "auto" ? getConfig().chatModel : this.model;
    const { providerId, model } = parseModelRef(ref);
    if (providerId === "gemini" || /gemini/i.test(model)) return 1_000_000;
    if (providerId === "openrouter" && /gemini|claude|gpt-oss|laguna|nemotron/i.test(model)) return 128_000;
    if (providerId === "ollama") return 32_768;
    return 128_000;
  }

  private contextMeter(): { enabled: boolean; usage: number } | undefined {
    const enabled = this.contextMeterEnabled();
    if (!enabled) return { enabled: false, usage: 0 };
    const messages = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    if (messages.length === 0) return { enabled: true, usage: 0 };
    const used = estimateConversationTokens(messages);
    const inputBudget = Math.max(4_000, this.contextWindowTokens() - 8_192);
    return { enabled: true, usage: Math.min(1, used / inputBudget) };
  }

  private pushContextUsage(): void {
    const meter = this.contextMeter();
    if (!meter) return;
    this.post({ type: "contextUsage", usage: meter.usage, enabled: meter.enabled });
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
    this.post({ type: "changes", changes: this.visibleChanges() });
  }

  /** Park the agent on an in-chat permission card (replaces the VS Code modal). */
  private requestPermission(
    tool: string,
    detail: string,
    reason?: string,
  ): Promise<"allow-always" | "allow-once" | "always-ask" | "deny"> {
    const id = `perm${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      if (this.pendingPermission) {
        this.pendingPermission.reject(new Error("Superseded by a newer permission request."));
      }
      this.pendingPermission = { id, resolve, reject };
      this.post({
        type: "permissionRequest",
        id,
        tool,
        detail,
        reason,
        preferred: this.permissionDefault,
      });
      this.sendState(true);
    });
  }

  /** Re-run a prior shell command in the IDE terminal or sandbox from the tool row menu. */
  private async rerunCommand(id: string, target: "terminal" | "sandbox"): Promise<void> {
    const item = this.items.find((i) => i.kind === "tool" && i.id === id);
    if (!item || item.kind !== "tool" || item.name !== "run_command") return;
    const command = item.argsSummary.trim();
    if (!command) return;

    if (!this.commandHost) {
      this.rootPath ??= workspaceRoot()?.fsPath ?? os.homedir();
      this.ensureTracker(this.rootPath);
      this.commandHost = new TerminalHost(this.tracker!, this.rootPath);
      this.commandHost.target = this.commandRunTarget;
    }

    this.commandRunTarget = target;
    this.commandHost.target = target;
    void vscode.workspace.getConfiguration("wright").update("commandRunTarget", target);

    const runId = `rerun${Date.now().toString(36)}`;
    this.items.push({
      kind: "tool",
      id: runId,
      name: "run_command",
      argsSummary: command,
      status: "running",
      output: "",
    });
    this.liveCommandId = runId;
    this.post({ type: "toolStart", id: runId, name: "run_command", argsSummary: command });
    this.sendState(true);

    try {
      const result = await this.commandHost.runCommand(command, {
        target,
        onChunk: (text) => {
          const row = this.items.find((i) => i.kind === "tool" && i.id === runId);
          if (row?.kind === "tool") {
            row.output = (row.output ?? "") + text;
          }
          this.post({ type: "toolOutput", id: runId, text });
        },
      });
      const parts = [
        `exit code: ${result.exitCode}`,
        result.stdout.trim() && `stdout:\n${result.stdout.trim()}`,
        result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
      ].filter(Boolean);
      const output = parts.join("\n\n");
      const status = result.exitCode === 0 ? "ok" : "error";
      const row = this.items.find((i) => i.kind === "tool" && i.id === runId);
      if (row?.kind === "tool") {
        row.status = status;
        row.output = output;
      }
      this.post({ type: "toolDone", id: runId, status, output });
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      const row = this.items.find((i) => i.kind === "tool" && i.id === runId);
      if (row?.kind === "tool") {
        row.status = "error";
        row.output = output;
      }
      this.post({ type: "toolDone", id: runId, status: "error", output });
    } finally {
      if (this.liveCommandId === runId) this.liveCommandId = undefined;
      this.sendState(this.abort !== undefined);
    }
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.sendState(this.abort !== undefined);
        this.refreshLocalModels();
        return;
      case "newChat":
        this.newChat();
        return;
      case "summarizeChat":
        await this.summarizeIntoNewChat();
        return;
      case "askUserAnswer": {
        if (this.pendingAsk && this.pendingAsk.id === msg.id) {
          const { resolve } = this.pendingAsk;
          this.pendingAsk = undefined;
          resolve(msg.text);
        }
        return;
      }
      case "permissionDecision": {
        if (this.pendingPermission && this.pendingPermission.id === msg.id) {
          const { resolve } = this.pendingPermission;
          this.pendingPermission = undefined;
          this.post({ type: "permissionCleared", id: msg.id });
          resolve(msg.decision);
        }
        return;
      }
      case "setCommandRunTarget": {
        this.commandRunTarget = msg.target;
        if (this.commandHost) this.commandHost.target = msg.target;
        void vscode.workspace.getConfiguration("wright").update("commandRunTarget", msg.target);
        this.sendState(this.abort !== undefined);
        return;
      }
      case "revealTerminal": {
        void this.commandHost?.revealTerminal();
        return;
      }
      case "rerunCommand": {
        await this.rerunCommand(msg.id, msg.target);
        return;
      }
      case "stop":
        this.abort?.abort();
        // Stop means stop everything — clear anything queued behind this turn.
        if (this.promptQueue.length) {
          this.promptQueue = [];
          this.postQueue();
        }
        if (this.pendingAsk) {
          this.pendingAsk.reject(new ModelError("aborted", "Question cancelled"));
          this.pendingAsk = undefined;
        }
        if (this.pendingPermission) {
          this.pendingPermission.reject(new ModelError("aborted", "Permission cancelled"));
          this.pendingPermission = undefined;
        }
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
        // Busy? Queue it (Cursor-style) instead of dropping — drained in order
        // after the current turn finishes.
        if (this.abort) {
          this.enqueuePrompt(msg);
        } else {
          await this.dispatchSend(msg);
        }
        return;
      case "removeQueued":
        this.promptQueue = this.promptQueue.filter((q) => q.id !== msg.id);
        this.postQueue();
        return;
      case "backgroundCommand":
        this.commandHost?.backgroundCurrent();
        return;
      case "clearQueue":
        this.promptQueue = [];
        this.postQueue();
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "wright");
        return;
      case "manageLocalModels": {
        // One-click local models: pick installed to use it, pick a
        // recommended one to download it — no settings involved.
        if (!(await ensureOllamaRunning())) {
          await offerOllamaInstall();
          return;
        }
        await this.showLocalModelPicker();
        return;
      }
      case "manageModels": {
        // Multi-select across NVIDIA + every cloud provider. Checked = shown
        // in the chat picker (cloud entries still need a key to appear).
        const config = getConfig();
        const clouds = getCloudProviders();
        type PickItem = vscode.QuickPickItem & { providerId: string; modelId: string };
        const items: PickItem[] = [];

        const nvidiaAll = [...new Set([...DEFAULT_MODEL_LIST, ...config.modelList])];
        for (const m of nvidiaAll) {
          items.push({
            label: m,
            description: "NVIDIA NIM",
            picked: config.modelList.includes(m),
            providerId: "nvidia",
            modelId: m,
          });
        }
        for (const p of clouds) {
          const catalogModels = PROVIDER_CATALOG[p.id]?.suggestedModels ?? [];
          const all = [...new Set([...catalogModels, ...p.models])];
          for (const m of all) {
            items.push({
              label: m,
              description: p.apiKey ? p.name : `${p.name} (no API key yet)`,
              detail: formatModelRef(p.id, m),
              picked: p.models.includes(m),
              providerId: p.id,
              modelId: m,
            });
          }
        }

        const picked = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          title: "Wright: models shown in the picker",
          placeHolder: "Uncheck to hide · cloud models need an API key in Settings to appear",
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!picked) return;

        const cfg = vscode.workspace.getConfiguration("wright");
        const nvidiaPicked = picked.filter((p) => p.providerId === "nvidia").map((p) => p.modelId);
        await cfg.update("models.list", nvidiaPicked, true);

        for (const cloud of clouds) {
          const models = picked.filter((p) => p.providerId === cloud.id).map((p) => p.modelId);
          await cfg.update(`providers.${cloud.id}.models`, models, true);
        }
        this.sendState(this.abort !== undefined);
        return;
      }
      case "restoreCheckpoint":
        await this.restoreCheckpoint(msg.id);
        return;
      case "secondOpinion":
        await this.runSecondOpinion();
        return;
      case "openFile": {
        const base = workspaceRoot()?.fsPath ?? this.rootPath ?? os.homedir();
        const rel = msg.path.replace(/\\/g, "/").replace(/^\.\//, "");
        const uri = path.isAbsolute(rel)
          ? vscode.Uri.file(rel)
          : vscode.Uri.joinPath(vscode.Uri.file(base), rel);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type & vscode.FileType.Directory) {
            await vscode.commands.executeCommand("revealInExplorer", uri);
          } else {
            await vscode.window.showTextDocument(uri, { preview: true });
          }
        } catch {
          vscode.window.showWarningMessage(`Wright: could not open ${msg.path}`);
        }
        return;
      }
      case "copyText":
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage("Wright: copied", 2_500);
        return;
      case "applyCode":
        await this.applyCodeToActiveFile(msg.code);
        return;
      case "listSessions":
        this.persistSession(); // make sure the current chat shows up too
        this.sendSessions();
        return;
      case "openSession":
        this.switchSession(msg.id);
        return;
      case "deleteSession":
        this.deleteSession(msg.id);
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
          // Already classified as a big task when we offered the plan.
          await this.handleSend(parked.text, { ...parked, mode: "agent", skipUserItem: true, big: true });
        }
        return;
      }
      case "queryFiles":
        await this.handleQueryFiles(msg.query, msg.token);
        return;
      case "queryWorkflows":
        this.post({ type: "workflowList", token: msg.token, entries: await listWorkflows(this.rootPath ?? workspaceRoot()?.fsPath ?? os.homedir()) });
        return;
      case "resolveDrops":
        await this.handleResolveDrops(msg.uris);
        return;
      case "pickAttachments":
        await this.pickAttachments();
        return;
      case "executePlan": {
        const pending = this.pendingPlan;
        this.pendingPlan = undefined;
        this.sendState(false);
        if (!pending) return;
        // Use the user's edited checklist when provided; else the raw plan.
        let message =
          msg.steps && msg.steps.length > 0
            ? executionMessageFromSteps(pending.task, msg.steps)
            : executionMessage(pending.task, pending.plan);
        // Cursor-style live plan file: write .wright/plan.md, open it beside
        // the chat, and have the agent tick steps off as it completes them.
        const planFile = await this.writePlanFile(pending.task, msg.steps ?? parsePlanSteps(pending.plan), pending.plan);
        this.planFileActive = planFile !== undefined; // unchecked steps keep auto-continue alive
        if (planFile) {
          message +=
            `\n\nA live plan document exists at ${planFile} (already open in the editor). ` +
            `IMPORTANT: immediately after you complete each step, use edit_file on ${planFile} to change that step's "- [ ]" to "- [x]" so the user can watch progress. Keep it in sync as you go.`;
        }
        await this.handleSend(message, { displayText: "▶ Build plan" });
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
      case "getHunks":
        await this.sendHunks(msg.path);
        return;
      case "acceptHunk":
        await this.applyHunk(msg.path, msg.index, "accept");
        return;
      case "rejectHunk":
        await this.applyHunk(msg.path, msg.index, "reject");
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

  // ── per-hunk review (Cursor-style granular accept/reject) ────────────

  private async computeHunks(path: string) {
    if (!this.tracker) return undefined;
    const snapshot = this.tracker.snapshot(path);
    if (snapshot === undefined) return undefined;
    let current: string;
    try {
      current = await this.tracker.readFile(path);
    } catch {
      return undefined;
    }
    const { structuredPatch } = await import("diff");
    const patch = structuredPatch(path, path, snapshot ?? "", current, "", "", { context: 2 });
    return { snapshot: snapshot ?? "", current, hunks: patch.hunks };
  }

  private async sendHunks(path: string): Promise<void> {
    const computed = await this.computeHunks(path);
    this.post({
      type: "fileHunks",
      path,
      hunks: (computed?.hunks ?? []).map((h) => ({
        header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
        lines: h.lines,
      })),
    });
  }

  private async applyHunk(path: string, index: number, action: "accept" | "reject"): Promise<void> {
    const computed = await this.computeHunks(path);
    const hunk = computed?.hunks[index];
    if (!computed || !hunk || !this.tracker) return;
    const oldLines = hunk.lines.filter((l) => !l.startsWith("+")).map((l) => l.slice(1));
    const newLines = hunk.lines.filter((l) => !l.startsWith("-")).map((l) => l.slice(1));

    if (action === "accept") {
      // Fold the hunk into the baseline: it is no longer "pending".
      const snapLines = computed.snapshot.split("\n");
      snapLines.splice(hunk.oldStart - 1, hunk.oldLines, ...newLines);
      this.tracker.setSnapshot(path, snapLines.join("\n"));
    } else {
      // Revert the hunk on disk: current lines go back to the old ones.
      const curLines = computed.current.split("\n");
      curLines.splice(hunk.newStart - 1, hunk.newLines, ...oldLines);
      await this.tracker.writeFile(path, curLines.join("\n"));
    }

    // Fully resolved file drops out of the changes list.
    const after = await this.computeHunks(path);
    if (after && after.hunks.length === 0) this.tracker.keep(path);
    await this.sendHunks(path);
    this.sendChanges();
  }

  private async openDiff(relPath: string): Promise<void> {
    if (!this.rootPath || !this.tracker) return;
    const kind = this.tracker.snapshot(relPath) === null ? "created" : "edited";
    const original = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}` });
    const current = vscode.Uri.joinPath(vscode.Uri.file(this.rootPath), relPath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      current,
      `${relPath} (Wright: ${kind})`,
      { preview: true },
    );

    // Accept/reject right from the diff: Keep replaces (accepts what's on
    // disk), Revert restores the original.
    const choice = await vscode.window.showInformationMessage(
      `${relPath}: keep Wright's changes?`,
      "Keep",
      "Revert",
    );
    if (choice === "Keep") {
      this.tracker?.keep(relPath);
    } else if (choice === "Revert") {
      await this.tracker?.revert(relPath);
    }
    if (choice) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").then(undefined, () => {});
      this.sendChanges();
    }
  }

  /**
   * "Apply" on a chat code block (Cursor-style): fast-model merge of the
   * snippet into the active editor file, written through the tracker so it
   * shows in the Changes panel with a reviewable diff.
   */
  private async applyCodeToActiveFile(code: string): Promise<void> {
    const config = getConfig();
    const base = workspaceRoot()?.fsPath ?? this.rootPath ?? os.homedir();
    const info = getActiveFile();
    if (!info) {
      vscode.window.showInformationMessage("Wright: open the file you want to apply the code to first.");
      return;
    }
    if (!hasAnyCloudCredential()) return;
    if (info.content.length > 48_000) {
      vscode.window.showWarningMessage("Wright: file too large for Apply — ask the agent to edit it instead.");
      return;
    }
    this.ensureTracker(base);
    this.rootPath ??= base;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Wright: applying to ${info.path}…` },
      async () => {
        const { client, agentModel } = await buildFailoverClient(
          this.model === "auto" || this.model.startsWith("ollama:") ? config.fastModel : this.model,
        );
        const result = await client.complete({
          model: agentModel,
          messages: [
            {
              role: "system",
              content:
                "You are a code merge engine. Integrate the SNIPPET into the FILE at the right place — replacing the " +
                "code it's clearly a new version of, or inserting it where it belongs. Preserve everything unrelated " +
                "exactly. Output ONLY the complete updated file, no fences, no commentary.",
            },
            { role: "user", content: `FILE (${info.path}):\n${info.content}\n\nSNIPPET:\n${code}` },
          ],
          max_tokens: 16_000,
          temperature: 0.1,
        });
        let merged = (result.message.content ?? "").trim().replace(/^```[\w-]*\n?|```$/g, "");
        if (!merged || merged.length < info.content.length / 4) {
          vscode.window.showWarningMessage("Wright: merge looked wrong — nothing applied.");
          return;
        }
        if (!merged.endsWith("\n") && info.content.endsWith("\n")) merged += "\n";
        await this.tracker!.writeFile(info.path, merged);
        this.sendChanges();
        vscode.window.setStatusBarMessage(`Wright: applied to ${info.path} — review in Changes`, 5_000);
      },
    ).then(undefined, (err) => vscode.window.showErrorMessage(`Wright: apply failed — ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * Is this request big enough that planning first would help? Cheap
   * word-count/keyword gate first; only genuinely ambiguous ones spend a
   * ~1s fast-model classification. Fails open (false) on any error.
   */
  private async looksLikeBigTask(text: string): Promise<boolean> {
    const words = text.trim().split(/\s+/).length;
    if (words < 12) return false;
    if (words > 120) return true;
    if (!BIG_TASK_SIGNALS.test(text)) return false;
    const config = getConfig();
    if (!hasAnyCloudCredential()) return false;
    try {
      const { client, agentModel } = await buildFailoverClient(config.fastModel);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const result = await client.complete(
        {
          model: agentModel,
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

  /**
   * Local-model manager: pick installed → use it; pick recommended →
   * download then use; 🗑 button on installed rows deletes from disk.
   */
  private async showLocalModelPicker(): Promise<void> {
    const installed = await listLocalModels();
    const installedNames = new Set(installed.map((m) => m.name));
    type Item = vscode.QuickPickItem & { modelName?: string };
    const trash = new vscode.ThemeIcon("trash");
    const items: Item[] = [
      ...installed.map((m) => ({
        label: m.name,
        modelName: m.name,
        description: `installed${m.sizeGb ? ` · ${m.sizeGb} GB` : ""}${m.tools ? " · tools" : ""}`,
        buttons: [{ iconPath: trash, tooltip: `Delete ${m.name} from disk` }],
      })),
      { label: "Download", kind: vscode.QuickPickItemKind.Separator },
      ...RECOMMENDED_LOCAL_MODELS.filter((r) => !installedNames.has(r.id)).map((r) => ({
        label: r.id,
        modelName: r.id,
        description: `⇩ ${r.blurb}`,
      })),
    ];

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Wright: local models (Ollama) — pick to use, download, or 🗑 delete";
    qp.items = items;
    qp.onDidTriggerItemButton(async (e) => {
      const name = e.item.modelName;
      if (!name) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${name} from disk${e.item.description?.includes("GB") ? ` (frees ${e.item.description.match(/([\d.]+ GB)/)?.[1] ?? "space"})` : ""}?`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;
      if (await deleteModel(name)) {
        vscode.window.setStatusBarMessage(`Wright: deleted ${name}`, 4_000);
        if (this.model === `ollama:${name}`) this.model = "auto";
        this.refreshLocalModels();
        qp.hide();
        await this.showLocalModelPicker(); // reopen with the fresh list
      } else {
        vscode.window.showErrorMessage(`Wright: could not delete ${name}.`);
      }
    });
    qp.onDidAccept(async () => {
      const pick = qp.selectedItems[0];
      qp.hide();
      if (!pick?.modelName) return;
      if (!installedNames.has(pick.modelName)) {
        if (!(await pullModel(pick.modelName))) return;
      }
      this.model = `ollama:${pick.modelName}`;
      this.agentBuiltFor = undefined;
      this.refreshLocalModels();
      this.sendState(this.abort !== undefined);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  private turnTouchesSensitive(text: string, files: FileAttachment[] | undefined, globs: string[]): boolean {
    return turnTouchesSensitiveImpl(text, (files ?? []).map((f) => f.path ?? f.name), globs);
  }

  /**
   * Resolve the model for this turn.
   *  - An explicitly picked model is ALWAYS honored (only images override it,
   *    since a non-vision model can't see them).
   *  - On "auto", route by task shape to the cheapest capable tier:
   *      images → vision · ask/small → fast · big/agent work → strong.
   */
  private resolveModel(mode: AgentMode, hasImages: boolean, big = false): string {
    const config = getConfig();
    if (hasImages) return config.visionModel;
    if (this.model !== "auto") return this.model; // explicit pick wins
    const r = config.routing;
    if (mode === "ask") return r.fast; // read-only Q&A → fast/cheap
    if (mode === "multi" || big) return r.strong; // many/large tasks → strongest coder
    if (mode === "debug") return r.strong; // debugging needs the good reasoner
    return r.balanced; // default agent turn
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

  /** Turn explorer/OS drop URIs into composer attachments (same tray as @ / paperclip). */
  private async handleResolveDrops(uris: string[]): Promise<void> {
    for (const raw of uris) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        const uri =
          /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? vscode.Uri.parse(trimmed) : vscode.Uri.file(trimmed);
        if (uri.scheme === "http" || uri.scheme === "https") {
          continue;
        }
        if (uri.scheme !== "file") continue;

        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & vscode.FileType.Directory) !== 0;
        const base = uri.fsPath.split(/[/\\]/).pop() ?? uri.fsPath;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(base);

        if (image && !isDir) {
          if (stat.size > 4_000_000) continue;
          const bytes = await vscode.workspace.fs.readFile(uri);
          const mime =
            /\.png$/i.test(base) ? "image/png"
            : /\.webp$/i.test(base) ? "image/webp"
            : /\.gif$/i.test(base) ? "image/gif"
            : "image/jpeg";
          this.post({
            type: "attachImage",
            dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
          });
          continue;
        }

        if (folder) {
          const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
          this.post({
            type: "attachSelection",
            file: {
              name: isDir ? `${base}/` : base,
              path: rel,
              kind: isDir ? "dir" : "file",
            },
          });
          continue;
        }

        // Outside the workspace: inline file contents (folders skipped).
        if (isDir) continue;
        if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|wasm|exe|dll|so|dylib)$/i.test(base)) continue;
        if (stat.size > 256_000) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf8");
        if (content.includes("\u0000")) continue;
        this.post({
          type: "attachSelection",
          file: { name: base, content: content.slice(0, 16_000), kind: "file" },
        });
      } catch {
        // skip unreadable drops
      }
    }
  }

  private async buildAgent(_apiKey: string, model: string, mode: AgentMode, research: ResearchMode, forceLocal = false): Promise<Agent> {
    const root = workspaceRoot();
    // No folder open? Root the agent at the home directory so it can still
    // read the filesystem and scaffold brand-new projects anywhere under ~.
    this.rootPath = root?.fsPath ?? os.homedir();
    const config = getConfig();

    // When the primary is a strong-tier model (auto-routed or picked), fail
    // over along the trustworthy strong chain before any weak/free provider.
    const preferChain = config.routing.strongChain.includes(model) ? config.routing.strongChain : undefined;
    let failover;
    try {
      failover = await buildFailoverClient(model, { requireOllamaIfPrimary: true, forceLocal, preferChain });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Ollama isn't reachable")) void offerOllamaInstall();
      throw err;
    }
    const { client, agentModel } = failover;

    this.ensureTracker(this.rootPath);
    // Commands run in a visible "Wright" terminal (or sandbox); edits still go through the tracker.
    this.commandHost = new TerminalHost(this.tracker!, this.rootPath);
    this.commandHost.target = this.commandRunTarget;
    this.commandHost.onChunk = (text) => {
      if (!this.liveCommandId) return;
      const item = this.items.find((i) => i.kind === "tool" && i.id === this.liveCommandId);
      if (item?.kind === "tool") {
        item.output = (item.output ?? "") + text;
        if (item.output.length > 200_000) item.output = item.output.slice(-180_000);
      }
      this.post({ type: "toolOutput", id: this.liveCommandId, text });
    };
    let tools = createBuiltinTools(this.commandHost);
    // Embeddings always ride NVIDIA (local models don't serve our embed model).
    const embedClient = new ModelClient(nvidiaProvider({ apiKeys: config.apiKeys, chatModel: config.chatModel }));
    const indexer = root && config.apiKeys.length ? await this.indexService.ensure(embedClient, root.fsPath) : undefined;
    if (indexer) tools.push(createCodebaseSearchTool(indexer));
    tools.push(createWebSearchTool(config.webSearch));
    tools.push(createReadUrlTool());
    tools.push(createDiagnosticsTool());
    tools.push(createGitHistoryTool(this.rootPath));
    this.memoryStore = new FileMemoryStore(this.rootPath);
    tools.push(createRememberTool(this.memoryStore));
    tools.push(
      createAskUserTool(async (payload, signal) => {
        const id = `ask${Date.now().toString(36)}`;
        return await new Promise<string>((resolve, reject) => {
          if (this.pendingAsk) {
            this.pendingAsk.reject(new Error("Superseded by a newer ask_user call."));
          }
          this.pendingAsk = { id, resolve, reject };
          this.post({ type: "askUser", id, questions: payload.questions });
          const onAbort = () => {
            if (this.pendingAsk?.id === id) {
              this.pendingAsk = undefined;
              reject(new ModelError("aborted", "Question cancelled"));
            }
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }),
    );
    if (mode === "ask") {
      const readOnly = new Set([
        "read_file",
        "list_dir",
        "git_history",
        "remember",
        "search",
        "codebase_search",
        "web_search",
        "read_url",
        "get_diagnostics",
        "ask_user",
      ]);
      tools = tools.filter((t) => readOnly.has(t.definition.function.name));
    }
    const rules = root ? await loadRulesFile(root.fsPath) : undefined;
    const userRules = config.userRules;
    const memories = memoriesBlock(await this.memoryStore.list());

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

    // Compaction is a short handoff — use the Settings → Fast model, not the agent brain.
    let summarizeClient = client;
    let summarizeModel = agentModel;
    try {
      const fast = await buildFailoverClient(config.fastModel, { requireOllamaIfPrimary: false });
      summarizeClient = fast.client;
      summarizeModel = fast.agentModel;
    } catch {
      // Fall back to the main agent model if the fast path isn't configured.
    }

    const agent = new Agent({
      client,
      model: agentModel,
      tools,
      summarizeClient,
      summarizeModel,
      // Match the real model window so we don't silently drop the task brief at ~56k.
      budget: new ContextBudget({
        contextWindow: this.contextWindowTokens(),
        outputReserve: 8_192,
      }),
      // Deep research fans out into many search rounds; give it headroom.
      maxIterations: (this.agentMaxIterations = research === "deep" ? 60 : research === "research" ? 40 : 25),
      systemPrompt:
        agentSystemPrompt({ workspaceName: vscode.workspace.name, rules, userRules, memories, mode, research }) +
        (root ? "" : NO_WORKSPACE_NOTE),
      approve: async (name, args) => {
        // Session trust from the in-chat permission card.
        if (this.sessionTrust === "admin" || this.sessionTrust === "session") return true;

        let decision = new ApprovalPolicy({ mode: this.approvalMode }).decide(name, args);
        // Settings → Rules: confirm deletes even when approval mode would allow.
        if (config.requireDeleteApproval && name === "run_command") {
          const cmd = String(args.command ?? "");
          if (/\b(rm|rmdir|unlink|del|Remove-Item|rd)\b/i.test(cmd)) {
            decision = { action: "ask", reason: "delete requires your permission (Rules)" };
          }
        }
        if (decision.action === "allow") return true;

        const detail =
          name === "run_command" ? String(args.command ?? "") : `${name} → ${String(args.path ?? "")}`;
        const choice = await this.requestPermission(name, detail, decision.reason);
        if (choice === "deny") return false;
        if (choice === "allow-always") {
          this.sessionTrust = "admin";
          this.permissionDefault = "allow-always";
          this.approvalMode = "auto";
          void vscode.workspace.getConfiguration("wright").update("permissionDefault", "allow-always");
          void vscode.workspace.getConfiguration("wright").update("approvalMode", "auto");
          this.sendState(true);
        } else if (choice === "allow-once") {
          this.sessionTrust = "session";
          this.permissionDefault = "allow-once";
          void vscode.workspace.getConfiguration("wright").update("permissionDefault", "allow-once");
          this.sendState(true);
        } else if (choice === "always-ask") {
          this.sessionTrust = undefined;
          this.permissionDefault = "always-ask";
          void vscode.workspace.getConfiguration("wright").update("permissionDefault", "always-ask");
          if (this.approvalMode === "auto") {
            this.approvalMode = "auto-edit";
            void vscode.workspace.getConfiguration("wright").update("approvalMode", "auto-edit");
          }
          this.sendState(true);
        }
        return true;
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
  /** Route one send message through workflows / plan / big-task / agent. */
  private async dispatchSend(msg: Extract<WebviewToHost, { type: "send" }>): Promise<void> {
    this.autoContinues = 0; // fresh user intent resets the auto-continue budget
    // "continue" while a plan is mid-execution RESUMES that plan — regardless
    // of the mode pill. Without this, Plan mode re-plans from scratch, which
    // is exactly the "it made a whole new plan" failure.
    if (
      !this.pendingPlan &&
      this.planFileActive &&
      isContinueMessage(msg.text) &&
      (await this.planHasUncheckedSteps())
    ) {
      await this.handleSend(
        `Resume executing the plan document at ${this.currentPlanRel ?? ".wright/plans/"} exactly where it left off. ` +
          `Open it, find the first unchecked "- [ ]" step, do it, tick it to "- [x]", and continue through every remaining step. ` +
          `Do NOT write a new plan — the plan already exists.`,
        { displayText: msg.text, mode: "agent" },
      );
      return;
    }
    this.planFileActive = false; // a stale plan must not hijack a NEW request
    // Reusable workflows: a leading /name expands into its saved recipe,
    // while the transcript keeps showing the short command the user typed.
    let workflowLabel: string | undefined;
    if (msg.text.startsWith("/")) {
      const expanded = await expandWorkflow(this.rootPath ?? workspaceRoot()?.fsPath ?? os.homedir(), msg.text);
      if (expanded !== msg.text) {
        workflowLabel = msg.text;
        msg.text = expanded;
      }
    }
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
        this.items.push({ kind: "text", role: "user", content: workflowLabel ?? msg.text, files: msg.files?.map((f) => f.name) });
        this.post({ type: "planSuggest" });
        this.sendState(false);
        return;
      }
      await this.handleSend(msg.text, { displayText: workflowLabel, images: msg.images, files: msg.files, mode, research: msg.research });
    }
  }

  private enqueuePrompt(msg: Extract<WebviewToHost, { type: "send" }>): void {
    this.promptQueue.push({ id: `q${this.queueSeq++}`, msg });
    this.postQueue();
  }

  private postQueue(): void {
    this.post({ type: "queue", items: this.promptQueue.map((q) => ({ id: q.id, text: q.msg.text })) });
  }

  /** After a turn ends, run the next queued prompt (if any and not busy). */
  private drainQueue(): void {
    if (this.abort || this.promptQueue.length === 0) return;
    const next = this.promptQueue.shift()!;
    this.postQueue();
    void this.dispatchSend(next.msg);
  }

  /**
   * A compact transcript of the last few turns, so plan generation (and any
   * "continue"-style task) is grounded in what already happened instead of
   * seeing only the bare task text.
   */
  private recentConversation(maxTurns = 8, perMsg = 900): string | undefined {
    const messages = this.agent ? this.agent.history : (this.savedMessages ?? []);
    const textOf = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: string }).text ?? "") : "[image]"))
          .join(" ");
      }
      return "";
    };
    const turns = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-maxTurns)
      .map((m) => {
        const body = textOf(m.content).trim().replace(/\s+/g, " ");
        if (!body) return "";
        const clipped = body.length > perMsg ? `${body.slice(0, perMsg)}…` : body;
        return `${m.role === "user" ? "User" : "Assistant"}: ${clipped}`;
      })
      .filter(Boolean);
    return turns.length ? turns.join("\n") : undefined;
  }

  private async handlePlan(task: string, feedback?: string): Promise<void> {
    if (this.abort) return;
    if (!hasAnyCloudCredential() && !this.model.startsWith("ollama:")) {
      this.post({
        type: "error",
        message: "No API key found. Add NVIDIA or a free provider key in Wright Settings → Providers.",
      });
      return;
    }
    const root = workspaceRoot(); // optional: without one we just plan without codebase context
    const config = getConfig();

    const priorPlan = feedback ? this.pendingPlan?.plan : undefined;
    this.pendingPlan = undefined;
    this.items.push({ kind: "text", role: "user", content: feedback ?? task });
    this.sendState(true);

    const planModelRef = this.model === "auto" ? config.chatModel : this.model;
    let client: ModelClient;
    let planModel: string;
    try {
      const failover = await buildFailoverClient(planModelRef);
      client = failover.client;
      planModel = failover.agentModel;
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      this.sendState(false);
      return;
    }
    this.abort = new AbortController();
    const planItem: Extract<UiItem, { kind: "text" }> = { kind: "text", role: "assistant", content: "" };
    this.items.push(planItem);
    this.post({ type: "assistantStart" });

    try {
      const embedClient = config.apiKeys.length
        ? new ModelClient(nvidiaProvider({ apiKeys: config.apiKeys, chatModel: config.chatModel }))
        : client;
      const indexer = root && config.apiKeys.length ? await this.indexService.ensure(embedClient, root.fsPath) : undefined;
      const context = indexer ? await planContext(indexer, task, this.abort.signal) : undefined;
      const history = this.recentConversation();
      const plan = await generatePlan(
        client,
        planModel,
        { task, context, priorPlan, feedback, history },
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
      this.post({ type: "planReady", steps: parsePlanSteps(plan) });
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
      this.drainQueue();
    }
  }

  private async handleSend(
    text: string,
    opts: { displayText?: string; images?: string[]; files?: FileAttachment[]; mode?: AgentMode; research?: ResearchMode; skipUserItem?: boolean; big?: boolean } = {},
  ): Promise<void> {
    if (this.abort) return; // already running; UI disables send, but guard anyway

    if (!hasAnyCloudCredential() && !this.model.startsWith("ollama:")) {
      this.post({
        type: "error",
        message:
          "No API key found. Add a NVIDIA key or enable OpenRouter / Groq / Gemini (etc.) in Wright Settings → Providers.",
      });
      return;
    }

    const config = getConfig();
    const mode = opts.mode ?? "agent";
    const research = opts.research ?? "off";
    // Cheap sync signal for the auto-router (no extra model call).
    const big = opts.big ?? isBigTaskHeuristic(text);
    const resolvedModel = this.resolveModel(mode, (opts.images?.length ?? 0) > 0, big);
    // Local-only when offline mode is on, or the turn touches a sensitive path.
    const forceLocal = config.offlineMode || this.turnTouchesSensitive(text, opts.files, config.sensitiveGlobs);
    if (forceLocal && !config.offlineMode) {
      this.items.push({ kind: "text", role: "assistant", content: "_🔒 Sensitive path involved — using your local model only (not sent to any cloud)._" });
    }
    try {
      if (
        !this.agent ||
        this.agentBuiltFor?.model !== resolvedModel ||
        this.agentBuiltFor.mode !== mode ||
        this.agentBuiltFor.research !== research ||
        this.agentBuiltFor.forceLocal !== forceLocal
      ) {
        // Carry the conversation across model/mode/research switches.
        if (this.agent) this.savedMessages = [...this.agent.history];
        this.agent = await this.buildAgent(config.apiKey ?? "", resolvedModel, mode, research, forceLocal);
        this.agentBuiltFor = { model: resolvedModel, mode, research, forceLocal };
      }
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Open a restore point for this turn, before any edits land.
    const checkpoint = this.checkpoints?.create(opts.displayText ?? text, this.items.length);
    if (!opts.skipUserItem) {
      this.items.push({
        kind: "text",
        role: "user",
        content: opts.displayText ?? text,
        images: opts.images,
        files: opts.files?.map((f) => f.name),
        checkpointId: checkpoint?.id,
      });
    }
    this.sendState(true);
    text = await this.expandMentions(text);
    text = await this.expandAttachments(text, opts.files);
    // Screenshot-to-fix: guide the vision model to locate & fix the shown UI.
    if ((opts.images?.length ?? 0) > 0 && mode !== "ask") {
      text +=
        "\n\n[The image(s) above are from this project's UI. If they show a bug or a mockup, first use search / codebase_search to find the responsible component(s) in the codebase, then make the change and verify. Don't guess the file — locate it.]";
    }

    this.abort = new AbortController();
    const start = Date.now();
    let currentText: Extract<UiItem, { kind: "text" }> | undefined;
    let currentThinking: Extract<UiItem, { kind: "thinking" }> | undefined;
    let thinkingStart = 0;
    /** Live file-writes: raw streaming args + their transcript items, by call id. */
    const writes = new Map<string, { raw: string; item: Extract<UiItem, { kind: "write" }> }>();
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
          case "tool_args_delta": {
            // Show write_file/edit_file code as it streams in.
            if (event.name !== "write_file" && event.name !== "edit_file") break;
            endThinking();
            currentText = undefined;
            let write = writes.get(event.id);
            if (!write) {
              write = { raw: "", item: { kind: "write", id: event.id, path: "…", code: "", status: "streaming" } };
              writes.set(event.id, write);
              this.items.push(write.item);
            }
            write.raw += event.text;
            const { path, code } = extractStreamingWrite(write.raw, event.name);
            if (path) write.item.path = path;
            if (code !== undefined && code.length > write.item.code.length) {
              write.item.code = code;
              this.post({ type: "writeCode", id: event.id, path: write.item.path, code });
            }
            break;
          }
          case "tool_start": {
            endThinking();
            currentText = undefined;
            const write = writes.get(event.id);
            if (write) {
              // Already rendered as a live write block; just mark it executing.
              write.item.status = "running";
              const content = (event.args.content ?? event.args.new_string) as string | undefined;
              if (typeof content === "string" && content.length > write.item.code.length) {
                write.item.code = content;
                this.post({ type: "writeCode", id: event.id, path: write.item.path, code: content });
              }
              break;
            }
            const argsSummary = summarizeArgs(event.name, event.args);
            this.items.push({ kind: "tool", id: event.id, name: event.name, argsSummary, status: "running" });
            if (event.name === "run_command") this.liveCommandId = event.id;
            this.post({ type: "toolStart", id: event.id, name: event.name, argsSummary });
            break;
          }
          case "tool_done": {
            if (this.liveCommandId === event.id) this.liveCommandId = undefined;
            const status = !event.approved ? "declined" : event.result.ok ? "ok" : "error";
            const write = writes.get(event.id);
            if (write) {
              write.item.status = status;
              this.post({ type: "writeDone", id: event.id, status });
            } else {
              const item = this.items.find((i) => i.kind === "tool" && i.id === event.id);
              if (item?.kind === "tool") {
                item.status = status;
                item.output = event.result.output;
              }
              this.post({ type: "toolDone", id: event.id, status, output: event.result.output });
            }
            if (event.name === "write_file" || event.name === "edit_file") this.sendChanges();
            break;
          }
          case "compacting": {
            endThinking();
            currentText = undefined;
            this.post({ type: "summarizing", active: true });
            this.sendState(true);
            break;
          }
          case "compacted": {
            this.post({ type: "summarizing", active: false });
            const note =
              `**Context handoff #${event.generation}**\n\n${event.summary}\n\n---\nContinuing from the compacted history.`;
            this.items.push({ kind: "text", role: "assistant", content: note });
            this.post({ type: "assistantStart" });
            this.post({ type: "delta", text: note });
            this.pushContextUsage();
            this.sendState(true);
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
            // Record how the turn ended; the finally block decides whether the
            // work is actually finished (cap hit, announced-but-undone action,
            // or unchecked plan steps) and auto-continues if not.
            this.lastTurnEnd = {
              capHit: event.iterations >= this.agentMaxIterations,
              finalText: event.finalText,
            };
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
      this.pushContextUsage();
      void this.maybeAutoCompact();
      const reason = await this.unfinishedWorkReason();
      this.lastTurnEnd = undefined;
      if (reason) {
        this.autoContinues += 1;
        const note = `_⏩ Auto-continuing (${this.autoContinues}/${AUTO_CONTINUE_MAX}) — ${reason}._`;
        this.items.push({ kind: "text", role: "assistant", content: note });
        this.post({ type: "assistantStart" });
        this.post({ type: "delta", text: note });
        const planNote = this.planFileActive && this.currentPlanRel
          ? ` Work through the unchecked steps in ${this.currentPlanRel} and tick each one off.`
          : "";
        void this.handleSend(
          `You stopped before the task was finished. Continue exactly where you left off — do the action you last announced, then keep going until every remaining step is done.${planNote} Do not stop again to narrate; act.`,
          { skipUserItem: true, mode },
        );
      } else {
        this.drainQueue();
      }
    }
  }

  /**
   * Decide whether the turn that just ended left work unfinished. Three
   * signals, in order of reliability:
   *  1. the per-turn step cap was hit (task physically truncated);
   *  2. an executed plan's .wright/plan.md still has unchecked "- [ ]" steps;
   *  3. the final text ANNOUNCES a next action ("Now I'll create the order
   *     routes…") — the model narrated intent and quit instead of acting.
   * Returns a human-readable reason, or undefined when the turn looks done.
   * Never fires when the model is asking the user something, or past budget.
   */
  private async unfinishedWorkReason(): Promise<string | undefined> {
    const end = this.lastTurnEnd;
    if (!end || this.autoContinues >= AUTO_CONTINUE_MAX || this.pendingAsk) return undefined;
    const text = end.finalText.trim();
    if (/\?\s*$/.test(text)) return undefined; // genuinely waiting on the user
    if (end.capHit) return "hit the per-turn step limit before finishing";
    if (this.planFileActive) {
      const open = await this.planHasUncheckedSteps();
      if (open === false) this.planFileActive = false; // plan finished — stand down
      if (open) return "the plan still has unchecked steps";
    }
    // Announced-but-undone: last sentence declares a future action. "let me
    // know" style sign-offs are excluded.
    const tail = text.slice(-220);
    const intent =
      /\b(?:i'?ll|i will|i'?m going to|i am going to|i need to|let me(?!\s+know))\s+[^.?!\n]{3,140}[.!]?\s*$/i.test(tail) ||
      /\b(?:next|now),?\s+(?:i'?ll|i will|let'?s|we)\b[^.?!\n]{0,140}[.!]?\s*$/i.test(tail);
    if (intent) return "it announced the next action but stopped before doing it";
    return undefined;
  }

  /** True if the current plan document still contains "- [ ]" steps. */
  private async planHasUncheckedSteps(): Promise<boolean | undefined> {
    if (!this.currentPlanUri) return undefined;
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.currentPlanUri)).toString("utf8");
      return hasUncheckedSteps(raw);
    } catch {
      return undefined; // plan file gone — no signal
    }
  }

  /**
   * Manual Summarize: compress this chat and open a fresh session seeded with
   * the summary so the user can continue without re-explaining.
   */
  private async summarizeIntoNewChat(): Promise<void> {
    const messages = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    const usable = messages.filter((m) => m.role !== "system");
    if (usable.length < 2) {
      vscode.window.showInformationMessage("Wright: not enough conversation to summarize yet.");
      return;
    }
    this.post({ type: "summarizing", active: true });
    try {
      const summary = await this.generateConversationSummary(messages);
      this.persistSession();
      this.abort?.abort();
      this.agent = undefined;
      this.agentBuiltFor = undefined;
      this.tracker = undefined;
      this.pendingPlan = undefined;
      this.sessionId = `s${Date.now().toString(36)}`;
      const seedUser: ChatMessage = {
        role: "user",
        content:
          "Continue from this summary of our previous chat. Treat it as the established context and keep going from where we left off.",
      };
      const seedAssistant: ChatMessage = {
        role: "assistant",
        content: summary,
      };
      this.savedMessages = [seedUser, seedAssistant];
      this.items = [
        {
          kind: "text",
          role: "assistant",
          content:
            "**Conversation summary** (continued from previous chat)\n\n" +
            summary +
            "\n\n---\nReady when you are — pick up from here.",
        },
      ];
      this.sendState(false);
      this.post({ type: "chatCleared" });
      this.pushContextUsage();
      vscode.window.setStatusBarMessage("Wright: opened a new chat with the summary", 4_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `Summarize failed: ${message}` });
    } finally {
      this.post({ type: "summarizing", active: false });
    }
  }

  /**
   * Auto-compact (Cursor-style): when context fills, replace history with a
   * summary in the *same* chat so work can continue. Uses the real model
   * window estimate — including NVIDIA — so long agent runs don't erase the
   * original task via silent FIFO trim alone.
   */
  private async maybeAutoCompact(): Promise<void> {
    const messages = this.agent ? [...this.agent.history] : (this.savedMessages ?? []);
    const nonSystem = messages.filter((m) => m.role !== "system");
    if (nonSystem.length < 4) return;

    const used = estimateConversationTokens(messages);
    const budget = Math.max(4_000, this.contextWindowTokens() - 8_192);
    if (used / budget < 0.75) return;

    this.post({ type: "summarizing", active: true });
    try {
      const summary = await this.generateConversationSummary(messages);
      const compacted: ChatMessage[] = [
        {
          role: "user",
          content:
            "Context was auto-compacted because the window was nearly full. Continue from this summary of our work so far — keep the original goals and do not re-ask what we already decided.",
        },
        { role: "assistant", content: summary },
      ];
      this.savedMessages = compacted;
      if (this.agent) this.agent.restoreHistory(compacted);
      this.items = [
        {
          kind: "text",
          role: "assistant",
          content:
            "**Context auto-summarized** (window was nearly full)\n\n" +
            summary +
            "\n\n---\nContinuing in this chat with a compressed history.",
        },
      ];
      this.persistSession();
      this.sendState(false);
      this.pushContextUsage();
    } catch {
      // Auto-compact is best-effort; leave history intact on failure.
    } finally {
      this.post({ type: "summarizing", active: false });
    }
  }

  private async generateConversationSummary(messages: ChatMessage[]): Promise<string> {
    const config = getConfig();
    const { client, agentModel } = await buildFailoverClient(config.fastModel, {
      requireOllamaIfPrimary: false,
    });
    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") {
          return `TOOL(${m.tool_call_id}): ${String(m.content).slice(0, 800)}`;
        }
        if (m.role === "assistant") {
          const tools = m.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 200)})`).join("; ");
          const body = (m.content ?? "").slice(0, 4_000);
          return tools ? `ASSISTANT: ${body}\n[tools: ${tools}]` : `ASSISTANT: ${body}`;
        }
        if (m.role === "user") {
          const body = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
          return `USER: ${body.slice(0, 4_000)}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 60_000);

    const result = await client.complete({
      model: agentModel,
      max_tokens: 2_048,
      messages: [
        {
          role: "system",
          content:
            "You compress a coding-agent conversation into a dense handoff summary. " +
            "ALWAYS preserve: the user's original goal/request, project name and paths, decisions already made, " +
            "files created/edited, current blocker, and the exact next step. " +
            "Drop: chatter, failed dead-ends, and raw tool dumps. Use short markdown sections. No preamble.",
        },
        {
          role: "user",
          content: `Summarize this chat for continuing the same task:\n\n${transcript}`,
        },
      ],
    });
    const text = result.message.content?.trim();
    if (!text) throw new Error("Model returned an empty summary");
    return text;
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
      if (file.kind === "dir" && file.path && this.tracker) {
        try {
          const entries = await this.tracker.listDir(file.path);
          const listing = entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).join("\n");
          blocks.push(`\n\n[Attached folder @${file.path} — contents]\n${listing.slice(0, 4_000)}`);
        } catch {
          blocks.push(`\n\n[Attached folder @${file.path}]`);
        }
        continue;
      }

      let content = file.content;
      if (content === undefined && file.path && this.tracker) {
        const rel = this.toWorkspaceRelative(file.path);
        try {
          content = await this.tracker.readFile(rel);
        } catch {
          // Might be a folder dropped without kind set.
          try {
            const entries = await this.tracker.listDir(rel);
            const listing = entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).join("\n");
            blocks.push(`\n\n[Attached folder @${rel} — contents]\n${listing.slice(0, 4_000)}`);
            continue;
          } catch {
            content = undefined;
          }
        }
      }
      if (content !== undefined) {
        const label = file.path ?? file.name;
        blocks.push(`\n\n[Attached file @${label}]\n\`\`\`\n${content.slice(0, 16_000)}\n\`\`\``);
      }
    }
    return blocks.length > 0 ? text + blocks.join("") : text;
  }

  /** Prefer workspace-relative paths for host file tools. */
  private toWorkspaceRelative(p: string): string {
    if (!p.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(p)) return p.replace(/\\/g, "/");
    const uri = vscode.Uri.file(p);
    if (!vscode.workspace.getWorkspaceFolder(uri)) return p;
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
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
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

/**
 * Pull the file path and the (still-streaming) code out of a partial
 * tool-arguments JSON string like `{"path":"src/a.ts","content":"import …`.
 * The code value may be cut mid-escape; trim until it decodes.
 */
export function extractStreamingWrite(raw: string, toolName: string): { path?: string; code?: string } {
  const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const path = pathMatch ? safeDecode(pathMatch[1]!) : undefined;

  const codeKey = toolName === "write_file" ? "content" : "new_string";
  const keyMatch = raw.match(new RegExp(`"${codeKey}"\\s*:\\s*"`));
  if (!keyMatch || keyMatch.index === undefined) return { path };

  let fragment = raw.slice(keyMatch.index + keyMatch[0].length);
  // If the closing quote of the value has arrived, stop there.
  const end = fragment.match(/(?:^|[^\\])(?:\\\\)*"/);
  if (end && end.index !== undefined) fragment = fragment.slice(0, end.index + end[0].length - 1);
  // Drop a trailing partial escape sequence (lone backslash or cut \uXXXX).
  fragment = fragment.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  const code = safeDecode(fragment);
  return { path, code };
}

function safeDecode(escaped: string): string | undefined {
  try {
    return JSON.parse(`"${escaped}"`) as string;
  } catch {
    return undefined;
  }
}
