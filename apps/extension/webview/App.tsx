import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { ChatMode, FileAttachment, HostToWebview, UiItem } from "../src/protocol.js";
import { post } from "./vscode.js";
import { Icon, IconButton, Select, toolIcon, type SelectOption } from "./components.js";

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return marked.parse(escaped, { async: false });
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

function modelLabel(id: string): string {
  if (id === "auto") return "Auto";
  return id.split("/").pop() ?? id;
}

/** What each model is best at — shown as the hint in the picker. */
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
          if (!defaultModeApplied.current) {
            defaultModeApplied.current = true;
            setMode(msg.defaultMode);
          }
          break;
        case "attachSelection":
          setPendingFiles((p) => [...p, msg.file]);
          inputRef.current?.focus();
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
    // Files dragged from the VS Code explorer arrive as a uri-list.
    const uriList = dt.getData("text/uri-list");
    if (uriList && dt.files.length === 0) {
      for (const line of uriList.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        try {
          const url = new URL(line.trim());
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
    post({ type: "send", text, mode, images: images.length ? images : undefined, files: files.length ? files : undefined });
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
      onDragOver={(e) => {
        e.preventDefault();
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

      <div className="messages" ref={scrollRef}>
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
            <TextMessage
              key={i}
              role={item.role}
              html={renderMarkdown(item.content || (busy && i === lastIndex ? "…" : ""))}
              streaming={busy && i === lastIndex && item.role === "assistant"}
              images={item.images}
              files={item.files}
            />
          ) : item.kind === "thinking" ? (
            <ThinkingBlock key={`th${i}`} item={item} streaming={busy && i === lastIndex} />
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
        {error && <div className="error-banner"><Icon name="x" size={13} />{error}</div>}
      </div>

      {changes.length > 0 && <ChangesPanel changes={changes} />}

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
              options={models.map((m) => ({ value: m, label: modelLabel(m), icon: m === "auto" ? "sparkle" : undefined, hint: MODEL_HINTS[m] }))}
              onChange={(v) => { setModel(v); post({ type: "setModel", model: v }); }}
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
                <Icon name="stop" size={12} /> Stop
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

function ChangesPanel({ changes }: { changes: Array<{ path: string; kind: "edited" | "created" }> }) {
  return (
    <div className="changes">
      <div className="changes-header">
        <span className="changes-title">
          Changes <span className="changes-count">{changes.length}</span>
        </span>
        <span className="changes-actions">
          <button className="btn small" onClick={() => post({ type: "keepAll" })}>Keep all</button>
          <button className="btn small danger" onClick={() => post({ type: "revertAll" })}>Revert all</button>
        </span>
      </div>
      {changes.map((c) => (
        <div key={c.path} className="change-row">
          <span className={`change-kind ${c.kind}`}>{c.kind === "created" ? "A" : "M"}</span>
          <button className="change-path" title={`Open diff: ${c.path}`} onClick={() => post({ type: "openDiff", path: c.path })}>
            {c.path}
          </button>
          <IconButton icon="check" title="Keep this change" onClick={() => post({ type: "keepFile", path: c.path })} size={12} />
          <IconButton icon="undo" title="Revert this file" danger onClick={() => post({ type: "revertFile", path: c.path })} size={12} />
        </div>
      ))}
    </div>
  );
}
