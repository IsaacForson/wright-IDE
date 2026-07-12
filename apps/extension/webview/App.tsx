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

/** Event delegation for the Apply/Copy buttons injected into markdown. */
function onMessagesClick(e: React.MouseEvent) {
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
  return marked.parse(escaped, { async: false }) as string;
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
  if (id.startsWith("gemini:")) return "gemini · reasoning";
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
    default: return name.startsWith("mcp_") ? `Using ${name.replace(/^mcp_/, "").replace(/_/g, " ")}` : `Running ${name}`;
  }
}

/**
 * Extract selectable options from an assistant question. Matches markdown
 * bullets like "- **Bookmarks** — a tab showing…", returning a short label
 * and the full option text to send. Only kicks in when the message reads
 * like a question (ends with "?", or offers a "recommended" pick).
 */
function extractOptions(text: string): Array<{ label: string; value: string }> {
  if (!/\?|recommended|or tell me/i.test(text)) return [];
  const opts: Array<{ label: string; value: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const body = m[1]!.trim();
    if (!body || body.length > 160) continue;
    if (body.endsWith("?")) continue; // a numbered question header, not an option
    // Prefer the bolded lead ("**Bookmarks**") as the chip label.
    const bold = body.match(/\*\*(.+?)\*\*/);
    const label = (bold ? bold[1]! : body.replace(/[*`]/g, "").split(/[—:\-–(]/)[0]!).trim().slice(0, 40);
    const value = body.replace(/\*\*/g, "").replace(/`/g, "");
    if (label) opts.push({ label, value });
  }
  return opts.length >= 2 && opts.length <= 8 ? opts : [];
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
  const [approvalMode, setApprovalMode] = useState<"manual" | "auto-edit" | "auto">("auto-edit");
  const [sessionStats, setSessionStats] = useState<string | undefined>();
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [mention, setMention] = useState<MentionState | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("Working");
  const [elapsed, setElapsed] = useState(0);
  /** Seconds left on the "big task — plan first?" countdown; undefined = hidden. */
  const [suggestLeft, setSuggestLeft] = useState<number | undefined>();
  /** Chat history overlay; undefined = closed. */
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; updatedAt: number; current: boolean }> | undefined>();
  /** Per-hunk review data for one expanded file in the Changes panel. */
  const [fileHunks, setFileHunks] = useState<{ path: string; hunks: Array<{ header: string; lines: string[] }> } | undefined>();

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

  // Elapsed-seconds ticker for the status line.
  useEffect(() => {
    if (!busy) return;
    if (!turnStart.current) turnStart.current = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - turnStart.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

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
          setSessionStats(msg.sessionStats);
          lastDefaultMode.current = msg.defaultMode;
          if (!defaultModeApplied.current) {
            defaultModeApplied.current = true;
            setMode(msg.defaultMode);
          }
          break;
        case "attachSelection":
          setPendingFiles((p) => [...p, msg.file]);
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
          setMode(lastDefaultMode.current); // fresh chat starts in the configured default mode
          break;
        case "planReady":
          setPlanPending(true);
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
  }, [items, stats]);

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
        setPendingFiles((p) => [...p, { name: file.name, content: reader.result as string }]);
      }
    };
    reader.readAsText(file);
  };

  const addDropped = (dt: DataTransfer) => {
    // Files dragged from the OS.
    for (const file of Array.from(dt.files)) {
      if (file.type.startsWith("image/")) addImageFile(file);
      else addTextFile(file);
    }
    // Files dragged from the VS Code explorer arrive as a uri-list — under
    // VS Code's own mime type, with text/uri-list as a fallback.
    const uriList = dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list");
    if (uriList && dt.files.length === 0) {
      for (const line of uriList.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        try {
          const url = new URL(line.trim());
          // Web links dropped into the chat: put the URL in the message so
          // the agent reads it with read_url.
          if (url.protocol === "http:" || url.protocol === "https:") {
            setInput((v) => (v ? `${v.trimEnd()} ${url.href} ` : `${url.href} `));
            continue;
          }
          if (url.protocol === "file:") {
            const fsPath = decodeURIComponent(url.pathname);
            const name = fsPath.split("/").pop() ?? fsPath;
            if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) continue; // host reads text only
            setPendingFiles((p) => (p.some((f) => f.path === fsPath) ? p : [...p, { name, path: fsPath }]));
          }
        } catch {
          // not a URI
        }
      }
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

  /** Send a specific string as the user's next message (used by option chips). */
  const sendValue = (value: string) => {
    if (busy) return;
    setError(undefined);
    setStats(undefined);
    setStatus("Thinking");
    turnStart.current = Date.now();
    setElapsed(0);
    if (planPending) setPlanPending(false);
    setItems((prev) => [...prev, { kind: "text", role: "user", content: value }]);
    post({ type: "send", text: value, mode, research });
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
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addDropped(e.dataTransfer);
      }}
    >
      {dragOver && (
        <div className="drop-overlay">
          <Icon name="attach" size={28} />
          <span>Drop files to attach as context</span>
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
        {items.map((item, i) =>
          item.kind === "text" ? (
            !busy && i === lastIndex && item.role === "assistant" && extractOptions(item.content).length > 0 ? (
              <QuestionMessage key={i} content={item.content} onAnswer={sendValue} />
            ) : (
            <TextMessage
              key={i}
              role={item.role}
              html={renderMarkdown(item.content || (busy && i === lastIndex ? "…" : ""))}
              streaming={busy && i === lastIndex && item.role === "assistant"}
              images={item.images}
              files={item.files}
            />
            )
          ) : item.kind === "thinking" ? (
            <ThinkingBlock key={`th${i}`} item={item} streaming={busy && i === lastIndex} />
          ) : item.kind === "write" ? (
            <WriteBlock key={item.id + i} item={item} />
          ) : (
            <ToolRow key={item.id + i} item={item} />
          ),
        )}
        {busy && (
          <div className="status-line">
            <Icon name="spinner" size={12} spin />
            <span className="status-text shimmer">{status}</span>
            {elapsed > 0 && <span className="status-elapsed">{elapsed}s</span>}
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
        <div className="plan-bar">
          <Icon name="book" size={14} />
          <span className="plan-label">Plan ready</span>
          <button className="btn primary" onClick={() => { setPlanPending(false); post({ type: "executePlan" }); }}>
            <Icon name="send" size={12} /> Execute
          </button>
          <button className="btn" onClick={() => { setPlanPending(false); post({ type: "discardPlan" }); }}>
            Discard
          </button>
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
                <div key={`file${i}`} className="attach-pill">
                  <Icon name="file" size={12} />
                  <span>{file.name}</span>
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
            rows={2}
            onChange={(e) => {
              setInput(e.target.value);
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />

          <div className="composer-bar">
            <label className="icon-button" title="Attach files or images">
              <Icon name="attach" size={14} />
              <input
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  for (const f of Array.from(e.target.files ?? [])) {
                    if (f.type.startsWith("image/")) addImageFile(f);
                    else addTextFile(f);
                  }
                  e.target.value = "";
                }}
              />
            </label>
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
                { value: "__manage__", label: "Manage cloud models…", icon: "gear" },
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
              <button className="btn primary stop" onClick={() => post({ type: "stop" })} title="Stop">
                <Icon name="stop" size={13} />
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0} title="Send (Enter)">
                <Icon name="send" size={13} />
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
 * An assistant question rendered Cursor-style: the option bullets ARE the
 * selectable buttons, and the free-form fallback is an inline input whose
 * placeholder is "…or tell me something else."
 */
function QuestionMessage({ content, onAnswer }: { content: string; onAnswer: (value: string) => void }) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<number | "custom" | undefined>();
  const options = extractOptions(content);
  // Strip the option bullets and the "or tell me" line from the prose.
  const prose = content
    .split("\n")
    .filter((line) => {
      if (/or tell me/i.test(line)) return false;
      const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      return !(m && !m[1]!.trim().endsWith("?") && m[1]!.trim().length <= 160);
    })
    .join("\n");
  const cleanValue = (v: string) => v.replace(/\s*\(recommended\)\.?/i, "").trim();
  const canSubmit = selected === "custom" ? custom.trim().length > 0 : selected !== undefined;
  const submit = () => {
    if (!canSubmit) return;
    onAnswer(selected === "custom" ? custom.trim() : cleanValue(options[selected as number]!.value));
  };
  return (
    <div className="message assistant">
      <div className="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(prose) }} />
      <div className="question-options">
        {options.map((o, i) => {
          const recommended = /recommended/i.test(o.value);
          const shown = cleanValue(o.value);
          return (
            <button
              key={i}
              className={`question-option${recommended ? " recommended" : ""}${selected === i ? " selected" : ""}`}
              onClick={() => setSelected(i)}
            >
              <span className="question-option-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown).replace(/^<p>|<\/p>\s*$/g, "") }} />
              {recommended && <span className="question-badge">recommended</span>}
              {selected === i && <Icon name="check" size={13} />}
            </button>
          );
        })}
        <input
          className={`question-input${selected === "custom" ? " selected" : ""}`}
          placeholder="…or tell me something else."
          value={custom}
          onFocus={() => setSelected("custom")}
          onChange={(e) => {
            setCustom(e.target.value);
            setSelected("custom");
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

function TextMessage(props: { role: "user" | "assistant"; html: string; streaming: boolean; images?: string[]; files?: string[] }) {
  return (
    <div className={`message ${props.role}`}>
      {props.role === "user" && <div className="message-role">You</div>}
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
    </div>
  );
}

function ThinkingBlock({ item, streaming }: { item: Extract<UiItem, { kind: "thinking" }>; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const label = streaming && item.seconds === 0 ? "Thinking…" : `Thought for ${Math.max(item.seconds, 1)}s`;
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

function ToolRow({ item }: { item: Extract<UiItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-row-wrap ${item.status}`}>
      <button className="tool-row" onClick={() => item.output && setOpen((o) => !o)} title={item.argsSummary}>
        <Icon name={toolIcon(item.name)} size={13} />
        <span className="tool-name">{item.name}</span>
        <span className="tool-args">{item.argsSummary}</span>
        <span className={`tool-status ${item.status}`}>
          {item.status === "running" ? <Icon name="spinner" size={12} spin /> : item.status === "ok" ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}
        </span>
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
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
