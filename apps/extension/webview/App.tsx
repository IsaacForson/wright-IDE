import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import ts from "highlight.js/lib/languages/typescript";
import js from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import type { ChatMode, FileAttachment, HostToWebview, ResearchMode, UiItem } from "../src/protocol.js";
import { post } from "./vscode.js";
import { Icon, IconButton, Select, toolIcon, type SelectOption } from "./components.js";

hljs.registerLanguage("typescript", ts);
hljs.registerLanguage("javascript", js);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("markdown", markdown);
const LANG_ALIASES: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", py: "python", sh: "bash", zsh: "bash", yml: "yaml", htm: "html", vue: "html", svelte: "html", md: "markdown" };

export function highlightCode(code: string, lang?: string): string {
  const resolved = LANG_ALIASES[lang ?? ""] ?? lang ?? "";
  try {
    if (resolved && hljs.getLanguage(resolved)) return hljs.highlight(code, { language: resolved }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

marked.setOptions({ gfm: true, breaks: true });
// Syntax-highlight fenced code blocks. Message text is pre-escaped, so undo
// that inside code before highlighting (hljs re-escapes safely).
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const raw = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      const encoded = btoa(unescape(encodeURIComponent(raw)));
      return `<div class="code-card" data-code="${encoded}"><div class="code-actions"><button data-act="apply" title="Apply to the active file">Apply</button><button data-act="copy" title="Copy code">Copy</button></div><pre><code class="hljs">${highlightCode(raw, lang)}</code></pre></div>`;
    },
  },
});

/** Event delegation for Apply/Copy and file links in markdown. */
function onMessagesClick(e: React.MouseEvent) {
  const fileLink = (e.target as HTMLElement).closest("a.file-link") as HTMLAnchorElement | null;
  if (fileLink?.dataset.path) {
    e.preventDefault();
    post({ type: "openFile", path: fileLink.dataset.path });
    return;
  }
  const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
  if (!btn) return;
  const card = btn.closest(".code-card") as HTMLElement | null;
  if (!card?.dataset.code) return;
  const code = decodeURIComponent(escape(atob(card.dataset.code)));
  if (btn.dataset.act === "copy") {
    post({ type: "copyText", text: code });
    btn.textContent = "Copied ✓";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  } else if (btn.dataset.act === "apply") {
    post({ type: "applyCode", code });
    btn.textContent = "Applying…";
    setTimeout(() => (btn.textContent = "Apply"), 4000);
  }
}

function renderMarkdown(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Preserve @path mentions as clickable file links through markdown parsing.
  const tokens: string[] = [];
  const withPlaceholders = escaped.replace(/(^|[\s(\[`])@([\w./\\-]+\/?)/g, (_, pre: string, path: string) => {
    const cleaned = path.replace(/\/$/, "");
    const i = tokens.length;
    tokens.push(cleaned);
    return `${pre}%%FILELINK${i}%%`;
  });
  let html = marked.parse(withPlaceholders, { async: false }) as string;
  html = html.replace(/%%FILELINK(\d+)%%/g, (_, i: string) => {
    const path = tokens[Number(i)] ?? "";
    return `<a class="file-link" href="#" data-path="${path}" title="Open ${path}">@${path}</a>`;
  });
  // Backtick paths like `src/app.ts` → clickable when they look like files.
  html = html.replace(/<code>([\w./\\-]+\.[a-zA-Z0-9]{1,12})<\/code>/g, (_, path: string) => {
    if (path.includes("://")) return `<code>${path}</code>`;
    return `<a class="file-link file-link-code" href="#" data-path="${path}" title="Open ${path}"><code>${path}</code></a>`;
  });
  return html;
}

/** Tools that Cursor folds into an "Explored / Read" activity group. */
function isExploreTool(name: string): boolean {
  return (
    name === "list_dir" ||
    name === "read_file" ||
    name === "search" ||
    name === "codebase_search" ||
    name === "read_url" ||
    name === "web_search" ||
    name === "get_diagnostics"
  );
}

type ToolItem = Extract<UiItem, { kind: "tool" }>;

type MessageBlock =
  | { type: "item"; item: UiItem; index: number }
  | { type: "explore"; tools: ToolItem[]; startIndex: number };

function groupMessageItems(items: UiItem[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === "tool" && isExploreTool(item.name)) {
      const tools: ToolItem[] = [];
      const start = i;
      while (i < items.length) {
        const next = items[i]!;
        if (next.kind !== "tool" || !isExploreTool(next.name)) break;
        tools.push(next);
        i++;
      }
      blocks.push({ type: "explore", tools, startIndex: start });
      continue;
    }
    blocks.push({ type: "item", item, index: i });
    i++;
  }
  return blocks;
}

const MODE_OPTIONS: SelectOption[] = [
  { value: "agent", label: "Agent", icon: "infinity", hint: "edits & runs code" },
  { value: "plan", label: "Plan", icon: "notebook", hint: "approve before executing" },
  { value: "debug", label: "Debug", icon: "bug2", hint: "reproduce → fix → verify" },
  { value: "ask", label: "Ask", icon: "chat", hint: "read-only Q&A" },
  { value: "multi", label: "Multi-task", icon: "checklist", hint: "checklist of tasks" },
];

const APPROVAL_OPTIONS: SelectOption[] = [
  { value: "manual", label: "manual", hint: "approve everything" },
  { value: "auto-edit", label: "auto-edit", hint: "commands ask" },
  { value: "auto", label: "auto", hint: "guardrails only" },
];

const RESEARCH_OPTIONS: SelectOption[] = [
  { value: "off", label: "Default", icon: "slash", hint: "no forced web search" },
  { value: "websearch", label: "Web Search", icon: "globe", hint: "back answers with the web" },
  { value: "research", label: "Research", icon: "compass", hint: "multi-query synthesis" },
  { value: "deep", label: "Deep Research", icon: "telescope", hint: "exhaustive, slower" },
];

function modelLabel(id: string): string {
  if (id === "auto") return "Auto";
  if (id.startsWith("ollama:")) return id.slice(7).replace(/:latest$/, "");
  const known = ["openrouter", "deepseek", "groq", "gemini", "cerebras", "mistral"];
  for (const p of known) {
    if (id.startsWith(p + ":")) {
      const rest = id.slice(p.length + 1);
      return rest.split("/").pop() ?? rest;
    }
  }
  return id.split("/").pop() ?? id;
}

function modelHint(id: string): string | undefined {
  if (id === "auto") return MODEL_HINTS.auto;
  if (id.startsWith("ollama:")) return "local · free";
  if (id.startsWith("openrouter:")) return "openrouter · free coding";
  if (id.startsWith("deepseek:")) return "deepseek · coding";
  if (id.startsWith("groq:")) return "groq · fast coding";
  if (id.startsWith("gemini:")) return "gemini · free coding";
  if (id.startsWith("cerebras:")) return "cerebras · fastest";
  if (id.startsWith("mistral:")) return "mistral · codestral";
  return MODEL_HINTS[id];
}

function modelIcon(id: string): string | undefined {
  if (id === "auto") return "sparkle";
  if (id.startsWith("ollama:")) return "terminal";
  if (
    id.startsWith("openrouter:") ||
    id.startsWith("deepseek:") ||
    id.startsWith("groq:") ||
    id.startsWith("gemini:") ||
    id.startsWith("cerebras:") ||
    id.startsWith("mistral:")
  ) {
    return "cloud";
  }
  return undefined;
}

/** What each NVIDIA model is best at — shown as the hint in the picker. */
const MODEL_HINTS: Record<string, string> = {
  auto: "routes per task",
  "z-ai/glm-5.2": "coding + UI design · fast",
  "mistralai/mistral-large-3-675b-instruct-2512": "strongest coding · fast",
  "deepseek-ai/deepseek-v4-pro": "deep reasoning",
  "moonshotai/kimi-k2.6": "agentic coding",
  "nvidia/nemotron-3-super-120b-a12b": "balanced · fast",
  "qwen/qwen3.5-122b-a10b": "coding + reasoning",
  "minimaxai/minimax-m3": "reasoning",
  "meta/llama-3.3-70b-instruct": "general",
  "meta/llama-3.1-8b-instruct": "fastest · light tasks",
};

/** Format elapsed seconds as "12s" or "1m 38s" (and "2h 3m" for long runs). */
function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return sec > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${h}h ${m}m` : `${h}h`;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

/** Human-readable live activity label for the status line. */
function activityLabel(name: string, args: string): string {
  const short = args.length > 46 ? args.slice(0, 46) + "…" : args;
  switch (name) {
    case "read_file": return `Reading ${short}`;
    case "edit_file": return `Editing ${short}`;
    case "write_file": return `Writing ${short}`;
    case "list_dir": return `Exploring ${short}`;
    case "search": return `Searching for "${short}"`;
    case "codebase_search": return `Searching the codebase`;
    case "web_search": return `Searching the web`;
    case "run_command": return `Running ${short}`;
    case "ask_user": return "Waiting for your answer";
    default: return name.startsWith("mcp_") ? `Using ${name.replace(/^mcp_/, "").replace(/_/g, " ")}` : `Running ${name}`;
  }
}

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface MentionState {
  query: string;
  /** Index into the textarea where the "@" starts. */
  anchor: number;
  entries: Array<{ path: string; type: "file" | "dir" }>;
  active: number;
}

export function App() {
  const [items, setItems] = useState<UiItem[]>([]);
  const [changes, setChanges] = useState<Array<{ path: string; kind: "edited" | "created" }>>([]);
  const [model, setModel] = useState("auto");
  const [models, setModels] = useState<string[]>(["auto"]);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [research, setResearch] = useState<ResearchMode>("off");
  const [planPending, setPlanPending] = useState(false);
  const [planSteps, setPlanSteps] = useState<Array<{ text: string; include: boolean }>>([]);
  const [approvalMode, setApprovalMode] = useState<"manual" | "auto-edit" | "auto">("auto-edit");
  const [sessionStats, setSessionStats] = useState<string | undefined>();
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [mention, setMention] = useState<MentionState | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [status, setStatus] = useState("Working");
  const [elapsed, setElapsed] = useState(0);
  /** Seconds left on the "big task — plan first?" countdown; undefined = hidden. */
  const [suggestLeft, setSuggestLeft] = useState<number | undefined>();
  /** Chat history overlay; undefined = closed. */
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; updatedAt: number; current: boolean }> | undefined>();
  /** Per-hunk review data for one expanded file in the Changes panel. */
  const [fileHunks, setFileHunks] = useState<{ path: string; hunks: Array<{ header: string; lines: string[] }> } | undefined>();
  const [contextUsage, setContextUsage] = useState(0);
  const [contextMeterEnabled, setContextMeterEnabled] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  /** Structured ask_user card from the host (topics ≠ options). */
  const [pendingAsk, setPendingAsk] = useState<
    | {
        id: string;
        questions: Array<{
          id: string;
          prompt: string;
          allow_multiple?: boolean;
          options: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
        }>;
      }
    | undefined
  >();
  /** In-chat tool permission card. */
  const [pendingPermission, setPendingPermission] = useState<
    | {
        id: string;
        tool: string;
        detail: string;
        reason?: string;
        preferred?: "always-ask" | "allow-once" | "allow-always";
      }
    | undefined
  >();
  const [commandRunTarget, setCommandRunTarget] = useState<"terminal" | "sandbox">("terminal");
  const [permissionDefault, setPermissionDefault] = useState<"always-ask" | "allow-once" | "allow-always">("always-ask");

  // Countdown for the plan suggestion: at 0, auto-continue with the agent.
  useEffect(() => {
    if (suggestLeft === undefined) return;
    if (suggestLeft <= 0) {
      setSuggestLeft(undefined);
      post({ type: "planDecision", usePlan: false });
      setStatus("Thinking");
      turnStart.current = Date.now();
      return;
    }
    const timer = setTimeout(() => setSuggestLeft((s) => (s === undefined ? s : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [suggestLeft]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionToken = useRef(0);
  const turnStart = useRef(0);
  /** Apply the configured default mode once, without clobbering user changes. */
  const defaultModeApplied = useRef(false);
  /** Latest wright.defaultMode from settings — re-applied on every New Chat. */
  const lastDefaultMode = useRef<ChatMode>("agent");

  const COMPOSER_MAX_PX = 360;

  /** Grow the composer with content (paste / long messages) up to a cap. */
  const resizeComposer = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, 44), COMPOSER_MAX_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_PX ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [input, resizeComposer]);

  // Elapsed-seconds ticker for the status line.
  useEffect(() => {
    if (!busy) return;
    if (!turnStart.current) turnStart.current = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - turnStart.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Drop overlay can stick if a drag is cancelled outside the webview (Esc /
  // drop on editor). Always clear on dragend/drop/Escape.
  useEffect(() => {
    const clearDrag = () => {
      dragDepth.current = 0;
      setDragOver(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearDrag();
    };
    window.addEventListener("dragend", clearDrag, true);
    window.addEventListener("drop", clearDrag, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("dragend", clearDrag, true);
      window.removeEventListener("drop", clearDrag, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", clearDrag);
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case "state":
          setItems(msg.items);
          setModel(msg.model);
          setModels(msg.models);
          setBusy(msg.busy);
          setChanges(msg.changes);
          setPlanPending(msg.planPending);
          setApprovalMode(msg.approvalMode);
          if (msg.permissionDefault) setPermissionDefault(msg.permissionDefault);
          if (msg.commandRunTarget) setCommandRunTarget(msg.commandRunTarget);
          setSessionStats(msg.sessionStats);
          lastDefaultMode.current = msg.defaultMode;
          setContextUsage(msg.contextUsage ?? 0);
          setContextMeterEnabled(!!msg.contextMeterEnabled);
          if (!defaultModeApplied.current) {
            defaultModeApplied.current = true;
            setMode(msg.defaultMode);
          }
          break;
        case "attachSelection":
          setPendingFiles((p) => {
            const key = msg.file.path ?? msg.file.name;
            if (p.some((f) => (f.path ?? f.name) === key)) return p;
            return [...p, msg.file];
          });
          inputRef.current?.focus();
          break;
        case "attachImage":
          setPendingImages((p) => [...p, msg.dataUrl]);
          inputRef.current?.focus();
          break;
        case "toggleHistory":
          setSessions((s) => {
            if (s) return undefined;
            post({ type: "listSessions" });
            return [];
          });
          break;
        case "chatCleared":
          setSessions(undefined);
          setPendingAsk(undefined);
          setPendingPermission(undefined);
          setMode(lastDefaultMode.current); // fresh chat starts in the configured default mode
          break;
        case "planReady":
          setPlanPending(true);
          setPlanSteps(msg.steps.map((text) => ({ text, include: true })));
          break;
        case "planSuggest":
          setBusy(false);
          setSuggestLeft(15);
          break;
        case "changes":
          setChanges(msg.changes);
          break;
        case "fileHunks":
          setFileHunks({ path: msg.path, hunks: msg.hunks });
          break;
        case "sessions":
          setSessions(msg.sessions);
          break;
        case "fileList":
          if (msg.token === mentionToken.current) {
            setMention((m) => (m ? { ...m, entries: msg.entries, active: 0 } : m));
          }
          break;
        case "assistantStart":
          setError(undefined);
          setStats(undefined);
          setBusy(true);
          setStatus("Writing");
          setItems((prev) => [...prev, { kind: "text", role: "assistant", content: "" }]);
          break;
        case "thinkingDelta":
          setBusy(true);
          setStatus("Thinking");
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.kind === "thinking") {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
            } else {
              next.push({ kind: "thinking", content: msg.text, seconds: 0 });
            }
            return next;
          });
          break;
        case "thinkingDone":
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const item = next[i]!;
              if (item.kind === "thinking") {
                next[i] = { ...item, seconds: msg.seconds };
                break;
              }
            }
            return next;
          });
          break;
        case "delta":
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.kind === "text" && last.role === "assistant") {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
            }
            return next;
          });
          break;
        case "toolStart":
          setBusy(true);
          setStatus(activityLabel(msg.name, msg.argsSummary));
          // ask_user parks on a dedicated card — don't show a "Running ask_user" tool row.
          if (msg.name === "ask_user") break;
          setItems((prev) => [
            ...prev,
            { kind: "tool", id: msg.id, name: msg.name, argsSummary: msg.argsSummary, status: "running" },
          ]);
          break;
        case "toolDone":
          setItems((prev) =>
            prev.map((item) =>
              item.kind === "tool" && item.id === msg.id ? { ...item, status: msg.status, output: msg.output } : item,
            ),
          );
          break;
        case "toolOutput":
          setItems((prev) =>
            prev.map((item) => {
              if (item.kind !== "tool" || item.id !== msg.id) return item;
              const output = (item.output ?? "") + msg.text;
              return { ...item, output: output.length > 200_000 ? output.slice(-180_000) : output };
            }),
          );
          break;
        case "askUser":
          setBusy(true);
          setStatus("Waiting for your answer");
          setPendingAsk({ id: msg.id, questions: msg.questions });
          break;
        case "permissionRequest":
          setBusy(true);
          setStatus("Waiting for permission");
          setPendingPermission({
            id: msg.id,
            tool: msg.tool,
            detail: msg.detail,
            reason: msg.reason,
            preferred: msg.preferred ?? permissionDefault,
          });
          break;
        case "permissionCleared":
          setPendingPermission((p) => (p?.id === msg.id ? undefined : p));
          break;
        case "writeCode":
          setBusy(true);
          setStatus(`Writing ${msg.path}`);
          setItems((prev) => {
            const idx = prev.findIndex((i) => i.kind === "write" && i.id === msg.id);
            if (idx === -1) return [...prev, { kind: "write", id: msg.id, path: msg.path, code: msg.code, status: "streaming" }];
            const next = [...prev];
            next[idx] = { ...(next[idx] as Extract<UiItem, { kind: "write" }>), path: msg.path, code: msg.code };
            return next;
          });
          break;
        case "writeDone":
          setItems((prev) =>
            prev.map((item) => (item.kind === "write" && item.id === msg.id ? { ...item, status: msg.status } : item)),
          );
          break;
        case "turnDone":
          setStats(msg.stats);
          turnStart.current = 0;
          setElapsed(0);
          setBusy(false);
          setPendingAsk(undefined);
          setPendingPermission(undefined);
          break;
        case "contextUsage":
          setContextUsage(msg.usage);
          setContextMeterEnabled(msg.enabled);
          break;
        case "summarizing":
          setSummarizing(msg.active);
          if (msg.active) {
            setBusy(true);
            setStatus("Compacting context");
          }
          // Do not clear busy here — mid-loop compaction continues the agent turn.
          break;
        case "error":
          setError(msg.message);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, stats, pendingAsk, pendingPermission]);

  // ── @-mention picker ─────────────────────────────────────────────────

  const updateMention = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = before.match(/@([\w./-]*)$/);
    if (!match) {
      setMention(undefined);
      return;
    }
    const query = match[1] ?? "";
    const anchor = caret - query.length - 1;
    setMention((m) => ({ query, anchor, entries: m?.query === query ? m.entries : [], active: 0 }));
    const token = ++mentionToken.current;
    post({ type: "queryFiles", query, token });
  }, []);

  const acceptMention = (entry: { path: string; type: "file" | "dir" }) => {
    if (!mention) return;
    const suffix = entry.type === "dir" ? "/ " : " ";
    const caretAfter = mention.anchor + 1 + entry.path.length + suffix.length;
    setInput((v) => v.slice(0, mention.anchor) + "@" + entry.path + suffix + v.slice(mention.anchor + 1 + mention.query.length));
    setMention(undefined);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caretAfter, caretAfter);
    });
  };

  // ── attachments ──────────────────────────────────────────────────────

  const addImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setPendingImages((p) => [...p, reader.result as string]);
    };
    reader.readAsDataURL(file);
  };

  const addTextFile = (file: File) => {
    if (file.size > 256_000) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPendingFiles((p) => [...p, { name: file.name, content: reader.result as string, kind: "file" }]);
      }
    };
    reader.readAsText(file);
  };

  /** Explorer/OS drops: Files type OR VS Code uri-list (often no Files entry). */
  const isAttachDrag = (dt: DataTransfer) => {
    const types = [...dt.types];
    return (
      types.includes("Files") ||
      types.includes("text/uri-list") ||
      types.includes("application/vnd.code.uri-list")
    );
  };

  const addDropped = (dt: DataTransfer) => {
    const uris: string[] = [];
    const seen = new Set<string>();
    const pushUri = (u: string) => {
      const t = u.trim();
      if (!t || t.startsWith("#") || seen.has(t)) return;
      seen.add(t);
      uris.push(t);
    };

    // VS Code explorer mimes — must read synchronously in the drop handler.
    for (const type of [
      "application/vnd.code.uri-list",
      "text/uri-list",
      "text/plain",
    ]) {
      const raw = dt.getData(type);
      if (!raw) continue;
      for (const line of raw.split(/\r?\n/)) pushUri(line);
    }

    for (const file of Array.from(dt.files)) {
      const electronPath = (file as File & { path?: string }).path;
      if (electronPath) {
        pushUri(electronPath);
        continue;
      }
      if (file.type.startsWith("image/")) addImageFile(file);
      else if (uris.length === 0) addTextFile(file);
    }

    const local: string[] = [];
    for (const u of uris) {
      if (/^https?:/i.test(u)) {
        setInput((v) => (v ? `${v.trimEnd()} ${u} ` : `${u} `));
      } else {
        local.push(u);
      }
    }

    if (local.length > 0) {
      post({ type: "resolveDrops", uris: local });
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          addImageFile(file);
        }
      }
    }
  };

  // ── send ─────────────────────────────────────────────────────────────

  const send = () => {
    const text = input.trim();
    const images = pendingImages;
    const files = pendingFiles;
    if ((!text && images.length === 0 && files.length === 0) || busy) return;
    setInput("");
    setPendingImages([]);
    setPendingFiles([]);
    setMention(undefined);
    setError(undefined);
    setStats(undefined);
    setStatus("Thinking");
    turnStart.current = Date.now();
    setElapsed(0);
    if (planPending) setPlanPending(false);
    setItems((prev) => [
      ...prev,
      { kind: "text", role: "user", content: text, images: images.length ? images : undefined, files: files.length ? files.map((f) => f.name) : undefined },
    ]);
    post({ type: "send", text, mode, research, images: images.length ? images : undefined, files: files.length ? files : undefined });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.entries.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % mention.entries.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active - 1 + mention.entries.length) % mention.entries.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptMention(mention.entries[mention.active]!);
        return;
      }
      if (e.key === "Escape") {
        setMention(undefined);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const lastIndex = items.length - 1;
  const placeholder = planPending
    ? "Type feedback to revise the plan…"
    : { agent: "Give Wright a task — @ to reference files…", plan: "Describe a feature — Wright plans before touching code…", debug: "Paste an error or describe the bug…", ask: "Ask about the codebase, or anything…", multi: "List several tasks — Wright works through them in order…" }[mode];

  return (
    <div
      className={`app${dragOver ? " drag-over" : ""}`}
      onDragEnter={(e) => {
        // Explorer drops often have uri-list without a Files type.
        if (!isAttachDrag(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!isAttachDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        // Still inside the panel — nested enter/leave noise.
        if (next && e.currentTarget.contains(next)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = 0;
        setDragOver(false);
        addDropped(e.dataTransfer);
      }}
    >
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          <Icon name="attach" size={28} />
          <span>Drop to attach as context</span>
          <span className="drop-overlay-hint">Hold Shift while dropping (VS Code requirement)</span>
        </div>
      )}

      {sessions && (
        <div className="sessions-panel">
          <div className="sessions-title">Recent chats <span className="sessions-note">kept 30 days</span></div>
          {sessions.length === 0 && <div className="sessions-empty">No saved chats yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`session-row${s.current ? " current" : ""}`}>
              <button
                className="session-main"
                onClick={() => {
                  setSessions(undefined);
                  if (!s.current) post({ type: "openSession", id: s.id });
                }}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-time">{relativeTime(s.updatedAt)}</span>
              </button>
              <IconButton icon="trash" title="Delete chat" danger size={12} onClick={() => post({ type: "deleteSession", id: s.id })} />
            </div>
          ))}
        </div>
      )}

      <div className="messages" ref={scrollRef} onClick={onMessagesClick}>
        {items.length === 0 && (
          <div className="empty">
            <div className="empty-logo">W</div>
            <div className="empty-title">Wright</div>
            <div className="empty-sub">An agent that reads, edits, and runs your code.</div>
            <div className="empty-hints">
              <span><kbd>@</kbd> reference files</span>
              <span><kbd>⌘V</kbd> paste images</span>
              <span>drag files in</span>
            </div>
          </div>
        )}
        {groupMessageItems(items).map((block) => {
          if (block.type === "explore") {
            return (
              <ExploreGroup
                key={`ex${block.startIndex}`}
                tools={block.tools}
                streaming={busy && block.startIndex + block.tools.length - 1 === lastIndex}
              />
            );
          }
          const item = block.item;
          const i = block.index;
          if (item.kind === "text") {
            // Cursor-style: selectable chips ONLY from ask_user (pendingAsk below).
            // Never scrape markdown bullets — that turns package.json dumps into fake answers.
            return (
              <TextMessage
                key={i}
                role={item.role}
                content={item.content}
                html={renderMarkdown(item.content || (busy && i === lastIndex ? "…" : ""))}
                streaming={busy && i === lastIndex && item.role === "assistant"}
                images={item.images}
                files={item.files}
                checkpointId={item.checkpointId}
                busy={busy}
                last={i === lastIndex && !busy}
              />
            );
          }
          if (item.kind === "thinking") {
            return <ThinkingBlock key={`th${i}`} item={item} streaming={busy && i === lastIndex} />;
          }
          if (item.kind === "write") {
            return <WriteBlock key={item.id + i} item={item} />;
          }
          if (item.kind === "council") {
            return <CouncilCard key={`co${i}`} item={item} />;
          }
          return item.name === "run_command"
            ? <CommandToolRow key={item.id + i} item={item} commandRunTarget={commandRunTarget} />
            : <ToolRow key={item.id + i} item={item} />;
        })}
        {pendingPermission && (
          <PermissionCard
            req={pendingPermission}
            onDecide={(decision) => {
              post({ type: "permissionDecision", id: pendingPermission.id, decision });
              setPendingPermission(undefined);
              setStatus(decision === "deny" ? "Thinking" : "Working");
            }}
          />
        )}
        {pendingAsk && (
          <AskUserMessage
            ask={pendingAsk}
            onSubmit={(text) => {
              post({ type: "askUserAnswer", id: pendingAsk.id, text });
              setPendingAsk(undefined);
              setStatus("Thinking");
            }}
          />
        )}
        {busy && (
          <div className="status-line">
            <Icon name="spinner" size={12} spin />
            <span className="status-text shimmer">{status}</span>
            {elapsed > 0 && <span className="status-elapsed">{formatElapsed(elapsed)}</span>}
          </div>
        )}
        {!busy && stats && <div className="turn-stats">{stats}</div>}
        {error && (
          <div className="error-banner">
            <span className="error-text">{error}</span>
            <button className="icon-button error-close" title="Dismiss" onClick={() => setError(undefined)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
      </div>

      {changes.length > 0 && <ChangesPanel changes={changes} fileHunks={fileHunks} onCollapse={() => setFileHunks(undefined)} />}

      {suggestLeft !== undefined && (
        <div className="plan-bar suggest">
          <Icon name="layers" size={14} />
          <span className="plan-label">Large task — plan it first?</span>
          <button
            className="btn primary"
            onClick={() => {
              setSuggestLeft(undefined);
              setMode("plan"); // reflect the switch in the mode pill
              post({ type: "planDecision", usePlan: true });
              setStatus("Thinking");
              turnStart.current = Date.now();
            }}
          >
            <Icon name="notebook" size={12} /> Plan first
          </button>
          <button
            className="btn"
            onClick={() => {
              setSuggestLeft(undefined);
              post({ type: "planDecision", usePlan: false });
              setStatus("Thinking");
              turnStart.current = Date.now();
            }}
          >
            Continue <span className="countdown">{suggestLeft}s</span>
          </button>
        </div>
      )}

      {planPending && !busy && (
        <div className="plan-review">
          {planSteps.length > 0 && (
            <div className="plan-steps">
              <div className="plan-steps-head">Review & edit the plan — uncheck to skip, or edit any step</div>
              {planSteps.map((s, i) => (
                <div key={i} className={`plan-step${s.include ? "" : " excluded"}`}>
                  <button
                    className="plan-step-check"
                    title={s.include ? "Skip this step" : "Include this step"}
                    onClick={() => setPlanSteps((p) => p.map((x, j) => (j === i ? { ...x, include: !x.include } : x)))}
                  >
                    <Icon name={s.include ? "check" : "circle"} size={12} />
                  </button>
                  <input
                    className="plan-step-text"
                    value={s.text}
                    onChange={(e) => setPlanSteps((p) => p.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                  <button
                    className="plan-step-del"
                    title="Delete step"
                    onClick={() => setPlanSteps((p) => p.filter((_, j) => j !== i))}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
              ))}
              <button
                className="plan-step-add"
                onClick={() => setPlanSteps((p) => [...p, { text: "", include: true }])}
              >
                <Icon name="plus" size={11} /> Add step
              </button>
            </div>
          )}
          <div className="plan-bar">
            <Icon name="book" size={14} />
            <span className="plan-label">Plan ready</span>
            <button
              className="btn primary"
              onClick={() => {
                setPlanPending(false);
                const steps = planSteps.filter((s) => s.include && s.text.trim()).map((s) => s.text.trim());
                post({ type: "executePlan", steps });
              }}
            >
              <Icon name="send" size={12} /> Execute
            </button>
            <button className="btn" onClick={() => { setPlanPending(false); post({ type: "discardPlan" }); }}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="composer-wrap">
        <div className="research-row">
          <Select
            value={research}
            options={RESEARCH_OPTIONS}
            onChange={(v) => setResearch(v as ResearchMode)}
            minWidth={230}
            title="Web & research depth"
            triggerClassName={`research-pill research-${research}`}
            iconSize={13}
          />
          <button
            className="summarize-btn"
            title="Summarize this chat and continue in a new chat"
            disabled={busy || summarizing || items.length < 2}
            onClick={() => post({ type: "summarizeChat" })}
          >
            <Icon name={summarizing ? "spinner" : "sparkle"} size={12} spin={summarizing} />
            Summarize
          </button>
          {contextMeterEnabled && (
            <span
              className="context-meter"
              title={`Context ${Math.round(contextUsage * 100)}% full — auto-summarizes near the limit`}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
                <circle
                  cx="9"
                  cy="9"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 7}`}
                  strokeDashoffset={`${2 * Math.PI * 7 * (1 - contextUsage)}`}
                  transform="rotate(-90 9 9)"
                  className={contextUsage >= 0.85 ? "context-meter-hot" : contextUsage >= 0.6 ? "context-meter-warm" : ""}
                />
              </svg>
              <span className="context-meter-pct">{Math.round(contextUsage * 100)}%</span>
            </span>
          )}
          {research !== "off" && <span className="research-note">answers grounded in live web sources</span>}
        </div>

        {mention && mention.entries.length > 0 && (
          <div className="mention-menu">
            {mention.entries.map((entry, i) => (
              <button
                key={entry.path}
                className={`mention-item${i === mention.active ? " active" : ""}`}
                onMouseEnter={() => setMention({ ...mention, active: i })}
                onClick={() => acceptMention(entry)}
              >
                <Icon name={entry.type === "dir" ? "folder" : "file"} size={13} />
                <span className="mention-name">{entry.path.split("/").pop()}</span>
                <span className="mention-path">{entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""}</span>
              </button>
            ))}
          </div>
        )}

        <div className="composer">
          {(pendingImages.length > 0 || pendingFiles.length > 0) && (
            <div className="attach-tray">
              {pendingImages.map((src, i) => (
                <div key={`img${i}`} className="attach-thumb">
                  <img src={src} alt="" />
                  <button className="attach-remove" onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}>
                    <Icon name="x" size={9} />
                  </button>
                </div>
              ))}
              {pendingFiles.map((file, i) => (
                <div key={`file${i}`} className="attach-pill" title={file.path ?? file.name}>
                  <Icon name={file.kind === "dir" ? "folder" : "file"} size={12} />
                  {file.path ? (
                    <button
                      type="button"
                      className="attach-pill-link"
                      onClick={() => post({ type: "openFile", path: file.path! })}
                    >
                      {file.path}
                    </button>
                  ) : (
                    <span>{file.name}</span>
                  )}
                  <button className="attach-remove inline" onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}>
                    <Icon name="x" size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            value={input}
            placeholder={placeholder}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onInput={resizeComposer}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              onPaste(e);
              // Paste updates value async via setState; also resize after DOM updates.
              requestAnimationFrame(() => resizeComposer());
            }}
          />

          <div className="composer-bar">
            <button
              type="button"
              className="icon-button"
              title="Attach files or folders"
              onClick={() => post({ type: "pickAttachments" })}
            >
              <Icon name="attach" size={14} />
            </button>
            <Select
              value={mode}
              options={MODE_OPTIONS}
              onChange={(v) => setMode(v as ChatMode)}
              minWidth={200}
              title="Mode"
              triggerClassName={`mode-pill mode-${mode}`}
              iconSize={14}
            />
            <Select
              value={model}
              options={[
                ...models.map((m) => ({
                  value: m,
                  label: modelLabel(m),
                  icon: modelIcon(m),
                  hint: modelHint(m),
                })),
                { value: "__manage__", label: "Manage models…", icon: "gear", hint: "show / hide any provider" },
                { value: "__local__", label: "Local models…", icon: "plus", hint: "download & use" },
              ]}
              onChange={(v) => {
                if (v === "__manage__") {
                  post({ type: "manageModels" });
                  return;
                }
                if (v === "__local__") {
                  post({ type: "manageLocalModels" });
                  return;
                }
                setModel(v);
                post({ type: "setModel", model: v });
              }}
              minWidth={270}
              title="Model"
            />
            <Select
              value={approvalMode}
              options={APPROVAL_OPTIONS}
              onChange={(v) => { setApprovalMode(v as typeof approvalMode); post({ type: "setApprovalMode", mode: v as typeof approvalMode }); }}
              minWidth={170}
              title="Approval mode"
            />
            <div className="spacer" />
            {busy ? (
              <button
                className="btn primary stop send-btn"
                onClick={() => {
                  setPendingAsk(undefined);
                  post({ type: "stop" });
                }}
                title="Stop"
              >
                <Icon name="stop" size={13} />
              </button>
            ) : (
              <button
                className="btn primary send-btn"
                onClick={send}
                disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                title="Send (Enter)"
              >
                <Icon name="send" size={14} />
              </button>
            )}
          </div>
        </div>
        {sessionStats && <div className="session-stats">{sessionStats}</div>}
      </div>
    </div>
  );
}

/**
 * Structured ask_user card — Cursor AskQuestion style.
 * Prompt = topic header; options = answers only. Never inferred from markdown.
 */
function AskUserMessage({
  ask,
  onSubmit,
}: {
  ask: {
    id: string;
    questions: Array<{
      id: string;
      prompt: string;
      allow_multiple?: boolean;
      options: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
    }>;
  };
  onSubmit: (text: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ask.questions.map((q) => [q.id, [] as string[]])),
  );
  const [custom, setCustom] = useState("");
  const [customMode, setCustomMode] = useState(false);

  const toggle = (qid: string, oid: string, multi: boolean) => {
    setCustomMode(false);
    setSelected((prev) => {
      const cur = prev[qid] ?? [];
      if (multi) {
        return { ...prev, [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] };
      }
      return { ...prev, [qid]: cur[0] === oid ? [] : [oid] };
    });
  };

  const picks = ask.questions.flatMap((q) => {
    const ids = selected[q.id] ?? [];
    return ids.map((oid) => {
      const opt = q.options.find((o) => o.id === oid);
      return opt ? `${q.prompt}: ${opt.label}` : "";
    }).filter(Boolean);
  });

  const canSubmit = customMode
    ? custom.trim().length > 0
    : ask.questions.every((q) => (selected[q.id] ?? []).length > 0);

  const submit = () => {
    if (!canSubmit) return;
    if (customMode) onSubmit(custom.trim());
    else onSubmit(picks.join("\n"));
  };

  return (
    <div className="message assistant ask-user">
      <div className="message-role">Wright</div>
      {ask.questions.map((q) => (
        <div key={q.id} className="question-group">
          <div className="question-group-title">{q.prompt}</div>
          <div className="question-options">
            {q.options.map((o) => {
              const on = (selected[q.id] ?? []).includes(o.id);
              return (
                <button
                  key={o.id}
                  className={`question-option${o.recommended ? " recommended" : ""}${on ? " selected" : ""}`}
                  onClick={() => toggle(q.id, o.id, !!q.allow_multiple)}
                >
                  <span className="question-option-text">
                    {o.label}
                    {o.description ? <span className="question-option-desc"> — {o.description}</span> : null}
                  </span>
                  {o.recommended && <span className="question-badge">recommended</span>}
                  {on && <Icon name="check" size={13} />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="question-options">
        <input
          className={`question-input${customMode ? " selected" : ""}`}
          placeholder="…or tell me something else."
          value={custom}
          onFocus={() => setCustomMode(true)}
          onChange={(e) => {
            setCustom(e.target.value);
            setCustomMode(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <div className="question-submit-row">
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            <Icon name="send" size={12} /> Submit
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      className={`message-copy${copied ? " copied" : ""}`}
      title={copied ? "Copied" : "Copy response"}
      onClick={() => {
        post({ type: "copyText", text });
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function TextMessage(props: {
  role: "user" | "assistant";
  content?: string;
  html: string;
  streaming: boolean;
  images?: string[];
  files?: string[];
  checkpointId?: string;
  busy?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`message ${props.role}`}>
      {props.role === "user" && (
        <div className="message-role">
          <span>You</span>
          {props.checkpointId && !props.busy && (
            <button
              className="restore-btn"
              title="Restore — rewind files & chat to before this message"
              onClick={() => post({ type: "restoreCheckpoint", id: props.checkpointId! })}
            >
              <Icon name="history" size={11} /> Restore
            </button>
          )}
        </div>
      )}
      {props.images && props.images.length > 0 && (
        <div className="message-images">
          {props.images.map((src, i) => <img key={i} src={src} alt="" />)}
        </div>
      )}
      {props.files && props.files.length > 0 && (
        <div className="message-files">
          {props.files.map((name, i) => (
            <span key={i} className="attach-pill static"><Icon name="file" size={11} />{name}</span>
          ))}
        </div>
      )}
      <div className={`message-body${props.streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: props.html }} />
      {props.role === "assistant" && !props.streaming && props.content && (
        <div className="message-actions">
          <MessageCopyButton text={props.content} />
          {props.last && (
            <button className="msg-action-btn" title="Ask another model the same question" onClick={() => post({ type: "secondOpinion" })}>
              <Icon name="layers" size={11} /> Second opinion
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CouncilCard({ item }: { item: Extract<UiItem, { kind: "council" }> }) {
  return (
    <div className="council-card">
      <div className="council-head">
        <Icon name="layers" size={12} />
        <span>Second opinions</span>
        {item.status === "running" && <Icon name="spinner" size={11} spin />}
      </div>
      {item.answers.map((a, i) => (
        <div key={i} className="council-answer">
          <div className="council-model">{a.label}</div>
          <div className="council-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.text) }} />
          <div className="council-actions"><MessageCopyButton text={a.text} /></div>
        </div>
      ))}
      {item.status === "running" && item.answers.length === 0 && (
        <div className="council-answer"><div className="council-text" style={{ opacity: 0.6 }}>Consulting other models…</div></div>
      )}
    </div>
  );
}

function ThinkingBlock({ item, streaming }: { item: Extract<UiItem, { kind: "thinking" }>; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const label = streaming && item.seconds === 0 ? "Thinking…" : `Thought for ${formatElapsed(Math.max(item.seconds, 1))}`;
  return (
    <div className="thinking-block">
      <button className="thinking-header" onClick={() => setOpen((o) => !o)}>
        <Icon name="sparkle" size={12} />
        <span className={streaming && item.seconds === 0 ? "shimmer" : ""}>{label}</span>
        <Icon name="chevron" size={10} />
      </button>
      {(open || (streaming && item.seconds === 0)) && (
        <div className="thinking-body">{item.content}</div>
      )}
    </div>
  );
}

/** A file being written live: filename header + code streaming in below. */
function WriteBlock({ item }: { item: Extract<UiItem, { kind: "write" }> }) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const lastHighlight = useRef(0);
  const [html, setHtml] = useState("");
  const streaming = item.status === "streaming" || item.status === "running";

  // Live syntax highlighting, throttled to ~4x/sec while code streams in.
  useEffect(() => {
    const now = Date.now();
    if (!streaming || now - lastHighlight.current > 250 || item.code.length < 2_000) {
      lastHighlight.current = now;
      const ext = item.path.split(".").pop()?.toLowerCase();
      setHtml(highlightCode(item.code, ext));
    }
  }, [item.code, item.path, streaming]);

  // Follow the code as it streams.
  useEffect(() => {
    if (streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [html, streaming]);

  const [copied, setCopied] = useState(false);
  return (
    <div className={`write-block ${item.status}`}>
      <div className="write-header">
        <Icon name="pencil" size={12} />
        <button className="write-path" title={`Open ${item.path}`} onClick={() => post({ type: "openFile", path: item.path })}>
          {item.path}
        </button>
        {streaming ? (
          <span className="tool-status running">
            <Icon name="spinner" size={12} spin />
          </span>
        ) : (
          <>
            {item.status !== "ok" && (
              <span className={`tool-status ${item.status}`}>
                <Icon name="x" size={12} />
              </span>
            )}
            <button
              className="icon-button"
              title="Copy code"
              onClick={() => {
                post({ type: "copyText", text: item.code });
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
            </button>
          </>
        )}
      </div>
      <pre ref={bodyRef} className={`write-body${streaming ? " streaming" : ""}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/**
 * In-chat permission dialog — replaces the VS Code modal.
 * Allow Always = admin for this session + persist auto mode.
 * Allow Once = trust for this chat session.
 * Always Ask = approve this call only; keep prompting next time.
 */
function PermissionCard({
  req,
  onDecide,
}: {
  req: {
    id: string;
    tool: string;
    detail: string;
    reason?: string;
    preferred?: "always-ask" | "allow-once" | "allow-always";
  };
  onDecide: (decision: "allow-always" | "allow-once" | "always-ask" | "deny") => void;
}) {
  const title =
    req.tool === "run_command"
      ? "Run this command?"
      : req.tool === "write_file" || req.tool === "edit_file"
        ? "Allow this file change?"
        : `Allow ${req.tool}?`;
  const preferred = req.preferred ?? "always-ask";

  return (
    <div className="message assistant permission-card">
      <div className="message-role">Wright</div>
      <div className="permission-title">{title}</div>
      {req.reason && <div className="permission-reason">{req.reason}</div>}
      <pre className="permission-detail">{req.detail}</pre>
      <div className="permission-actions">
        <button
          type="button"
          className={`permission-btn${preferred === "allow-always" ? " primary" : ""}`}
          onClick={() => onDecide("allow-always")}
        >
          Allow always
        </button>
        <button
          type="button"
          className={`permission-btn${preferred === "allow-once" ? " primary" : ""}`}
          onClick={() => onDecide("allow-once")}
        >
          Allow once
        </button>
        <button
          type="button"
          className={`permission-btn${preferred === "always-ask" ? " primary" : ""}`}
          onClick={() => onDecide("always-ask")}
        >
          Always ask
        </button>
        <button type="button" className="permission-btn ghost" onClick={() => onDecide("deny")}>
          Deny
        </button>
      </div>
      <div className="permission-hint">
        Always = full access · Once = this chat session · Always ask = this step only. Change the default in Wright Settings → Permissions.
      </div>
    </div>
  );
}

function ToolRow({ item }: { item: Extract<UiItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const pathLike = /^(read_file|edit_file|list_dir|write_file)$/.test(item.name) && item.argsSummary;
  return (
    <div className={`tool-row-wrap ${item.status}`}>
      <button className="tool-row" onClick={() => item.output && setOpen((o) => !o)} title={item.argsSummary}>
        <Icon name={toolIcon(item.name)} size={13} />
        <span className="tool-label">{toolVerb(item.name)}</span>
        {pathLike ? (
          <span
            className="tool-path file-link"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "openFile", path: item.argsSummary });
            }}
          >
            {item.argsSummary}
          </span>
        ) : (
          <span className="tool-args">{item.argsSummary}</span>
        )}
        <span className={`tool-status ${item.status}`}>
          {item.status === "running" ? <Icon name="spinner" size={12} spin /> : item.status === "ok" ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}
        </span>
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
    </div>
  );
}

/** Shell command row: click to expand live/finished output; menu for terminal vs sandbox. */
function CommandToolRow({
  item,
  commandRunTarget,
}: {
  item: Extract<UiItem, { kind: "tool" }>;
  commandRunTarget: "terminal" | "sandbox";
}) {
  const [open, setOpen] = useState(item.status === "running");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (item.status === "running") setOpen(true);
  }, [item.status]);

  useEffect(() => {
    if (open && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [item.output, open]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const hasOutput = !!(item.output && item.output.trim());

  return (
    <div className={`tool-row-wrap command-row ${item.status}`}>
      <div className="tool-row command-tool-row">
        <button
          type="button"
          className="command-main"
          onClick={() => setOpen((o) => !o)}
          title={item.argsSummary}
        >
          <span className={`explore-chevron${open ? " open" : ""}`}>
            <Icon name="chevron" size={10} />
          </span>
          <Icon name="terminal" size={13} />
          <span className="tool-label">{item.status === "running" ? "Running" : "Ran"}</span>
          <span className="tool-args">{item.argsSummary}</span>
          <span className={`tool-status ${item.status}`}>
            {item.status === "running" ? (
              <Icon name="spinner" size={12} spin />
            ) : item.status === "ok" ? (
              <Icon name="check" size={12} />
            ) : (
              <Icon name="x" size={12} />
            )}
          </span>
        </button>
        <div className="command-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button command-menu-btn"
            title="Command options"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
          >
            <Icon name="more" size={14} />
          </button>
          {menuOpen && (
            <div className="command-menu">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: "revealTerminal" });
                }}
              >
                Open IDE terminal
              </button>
              <button
                type="button"
                disabled={item.status === "running"}
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: "rerunCommand", id: item.id, target: "terminal" });
                }}
              >
                Run in IDE terminal
              </button>
              <button
                type="button"
                disabled={item.status === "running"}
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: "rerunCommand", id: item.id, target: "sandbox" });
                }}
              >
                Run in sandbox
              </button>
              <div className="command-menu-sep" />
              <button
                type="button"
                className={commandRunTarget === "terminal" ? "active" : ""}
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: "setCommandRunTarget", target: "terminal" });
                }}
              >
                Default: IDE terminal
              </button>
              <button
                type="button"
                className={commandRunTarget === "sandbox" ? "active" : ""}
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: "setCommandRunTarget", target: "sandbox" });
                }}
              >
                Default: sandbox
              </button>
            </div>
          )}
        </div>
      </div>
      {open && (
        <pre ref={outputRef} className={`tool-output command-output${item.status === "running" ? " live" : ""}`}>
          {hasOutput ? item.output : item.status === "running" ? "Waiting for output…" : "(no output)"}
        </pre>
      )}
    </div>
  );
}

function toolVerb(name: string): string {
  switch (name) {
    case "read_file": return "Read";
    case "edit_file": return "Edited";
    case "write_file": return "Wrote";
    case "list_dir": return "Listed";
    case "search": return "Searched";
    case "codebase_search": return "Searched";
    case "run_command": return "Ran";
    case "web_search": return "Web";
    case "read_url": return "Fetched";
    case "get_diagnostics": return "Diagnostics";
    default: return name.replace(/^mcp_/, "").replace(/_/g, " ");
  }
}

/**
 * Cursor-style collapsible explore block: one summary line, expand for paths.
 */
function ExploreGroup({ tools, streaming }: { tools: ToolItem[]; streaming: boolean }) {
  const allDone = tools.every((t) => t.status !== "running");
  const [open, setOpen] = useState(!allDone);
  const running = tools.find((t) => t.status === "running");
  const failed = tools.some((t) => t.status === "error" || t.status === "declined");

  // Auto-collapse when the group finishes (Cursor-like).
  useEffect(() => {
    if (allDone && !streaming) setOpen(false);
  }, [allDone, streaming]);

  const paths = tools
    .map((t) => t.argsSummary.trim())
    .filter(Boolean);
  const unique = [...new Set(paths)];
  const reads = tools.filter((t) => t.name === "read_file").length;
  const lists = tools.filter((t) => t.name === "list_dir").length;
  const searches = tools.filter((t) => t.name === "search" || t.name === "codebase_search" || t.name === "web_search").length;

  let summary = "Explored";
  if (reads && !lists && !searches) summary = reads === 1 ? "Read" : `Read ${reads} files`;
  else if (lists && !reads && !searches) summary = lists === 1 ? "Listed" : `Listed ${lists} folders`;
  else if (searches && !reads && !lists) summary = searches === 1 ? "Searched" : `Searched ${searches}×`;
  else summary = `Explored ${unique.length || tools.length} path${(unique.length || tools.length) === 1 ? "" : "s"}`;

  return (
    <div className={`explore-group${failed ? " failed" : ""}`}>
      <button type="button" className="explore-summary" onClick={() => setOpen((o) => !o)}>
        <span className={`explore-chevron${open ? " open" : ""}`}>
          <Icon name="chevron" size={10} />
        </span>
        {running ? <Icon name="spinner" size={12} spin /> : <Icon name="folder" size={12} />}
        <span className="explore-summary-text">
          {running ? toolVerb(running.name) : summary}
          {running && running.argsSummary ? (
            <span className="explore-summary-path"> {running.argsSummary}</span>
          ) : (
            !running && unique.length > 0 && unique.length <= 3 && (
              <span className="explore-summary-path"> {unique.map((p) => p.split("/").pop()).join(", ")}</span>
            )
          )}
        </span>
        {!running && <span className="explore-count">{tools.length}</span>}
      </button>
      {open && (
        <div className="explore-details">
          {tools.map((t) => {
            const path = t.argsSummary.trim();
            const clickable = path && /^(read_file|list_dir)$/.test(t.name);
            return (
              <div key={t.id} className={`explore-item ${t.status}`}>
                <Icon name={toolIcon(t.name)} size={11} />
                <span className="explore-verb">{toolVerb(t.name)}</span>
                {clickable ? (
                  <button type="button" className="file-link explore-path" onClick={() => post({ type: "openFile", path })}>
                    {path}
                  </button>
                ) : (
                  <span className="explore-path muted">{path || t.name}</span>
                )}
                <span className={`tool-status ${t.status}`}>
                  {t.status === "running" ? <Icon name="spinner" size={10} spin /> : t.status === "ok" ? null : <Icon name="x" size={10} />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChangesPanel({
  changes,
  fileHunks,
  onCollapse,
}: {
  changes: Array<{ path: string; kind: "edited" | "created" }>;
  fileHunks?: { path: string; hunks: Array<{ header: string; lines: string[] }> };
  onCollapse: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="changes">
      <div className="changes-header">
        <button className={`icon-button hunk-toggle${collapsed ? "" : " open"}`} title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>
          <Icon name="chevron" size={11} />
        </button>
        <span className="changes-title">
          Changes <span className="changes-count">{changes.length}</span>
        </span>
        <span className="changes-actions">
          <button className="btn small" onClick={() => post({ type: "keepAll" })}>Keep all</button>
          <button className="btn small danger" onClick={() => post({ type: "revertAll" })}>Revert all</button>
        </span>
      </div>
      {!collapsed && changes.map((c) => {
        const expanded = fileHunks?.path === c.path;
        return (
          <div key={c.path}>
            <div className="change-row">
              <button
                className={`icon-button hunk-toggle${expanded ? " open" : ""}`}
                title={expanded ? "Collapse hunks" : "Review individual hunks"}
                onClick={() => (expanded ? onCollapse() : post({ type: "getHunks", path: c.path }))}
              >
                <Icon name="chevron" size={11} />
              </button>
              <span className={`change-kind ${c.kind}`}>{c.kind === "created" ? "A" : "M"}</span>
              <button className="change-path" title={`Open diff: ${c.path}`} onClick={() => post({ type: "openDiff", path: c.path })}>
                {c.path}
              </button>
              <IconButton icon="check" title="Keep this change" onClick={() => post({ type: "keepFile", path: c.path })} size={12} />
              <IconButton icon="undo" title="Revert this file" danger onClick={() => post({ type: "revertFile", path: c.path })} size={12} />
            </div>
            {expanded &&
              fileHunks.hunks.map((h, i) => (
                <div key={i} className="hunk">
                  <div className="hunk-header">
                    <span className="hunk-range">{h.header}</span>
                    <IconButton icon="check" title="Accept this hunk" onClick={() => post({ type: "acceptHunk", path: c.path, index: i })} size={11} />
                    <IconButton icon="undo" title="Reject this hunk" danger onClick={() => post({ type: "rejectHunk", path: c.path, index: i })} size={11} />
                  </div>
                  <pre className="hunk-body">
                    {h.lines.map((line, j) => (
                      <div key={j} className={`hunk-line ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}`}>
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
