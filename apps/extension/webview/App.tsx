import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { FileChangeItem, HostToWebview, UiItem } from "../src/protocol.js";
import { post } from "./vscode.js";

marked.setOptions({ gfm: true, breaks: true });

/** Render model markdown to HTML, escaping raw HTML in the source. */
function renderMarkdown(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return marked.parse(escaped, { async: false });
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_file: "✏️",
  edit_file: "✏️",
  list_dir: "📁",
  search: "🔍",
  run_command: "❯",
};

export function App() {
  const [items, setItems] = useState<UiItem[]>([]);
  const [changes, setChanges] = useState<FileChangeItem[]>([]);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [planFirst, setPlanFirst] = useState(false);
  const [planPending, setPlanPending] = useState(false);
  const [approvalMode, setApprovalMode] = useState<"manual" | "auto-edit" | "auto">("auto-edit");
  const [sessionStats, setSessionStats] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Streaming deltas mutate the last item; keep a ref to avoid stale closures.
  const itemsRef = useRef(items);
  itemsRef.current = items;

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
          break;
        case "planReady":
          setPlanPending(true);
          break;
        case "changes":
          setChanges(msg.changes);
          break;
        case "assistantStart":
          setError(undefined);
          setStats(undefined);
          setBusy(true);
          setItems((prev) => [...prev, { kind: "text", role: "assistant", content: "" }]);
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

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(undefined);
    setStats(undefined);
    if (planPending) setPlanPending(false); // typed text = revision feedback
    setItems((prev) => [...prev, { kind: "text", role: "user", content: text }]);
    post({ type: "send", text, planFirst });
  };

  const lastIndex = items.length - 1;

  return (
    <div className="app">
      <div className="messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="empty">
            <div className="empty-title">Wright</div>
            <div className="empty-sub">An agent with tools. Ask it to read, search, edit, and run things.</div>
          </div>
        )}
        {items.map((item, i) =>
          item.kind === "text" ? (
            <TextMessage
              key={i}
              role={item.role}
              html={renderMarkdown(item.content || (busy && i === lastIndex ? "…" : ""))}
              streaming={busy && i === lastIndex && item.role === "assistant"}
            />
          ) : (
            <ToolChip key={item.id + i} item={item} />
          ),
        )}
        {!busy && stats && <div className="stats">{stats}</div>}
        {error && <div className="error">{error}</div>}
      </div>

      {changes.length > 0 && <ChangesPanel changes={changes} />}

      {planPending && !busy && (
        <div className="plan-bar">
          <span className="plan-label">Plan ready — run it?</span>
          <button
            className="send"
            onClick={() => {
              setPlanPending(false);
              post({ type: "executePlan" });
            }}
          >
            ▶ Execute plan
          </button>
          <button
            onClick={() => {
              setPlanPending(false);
              post({ type: "discardPlan" });
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className="composer">
        <textarea
          value={input}
          placeholder={
            planPending
              ? "Type feedback to revise the plan…"
              : planFirst
                ? "Describe a feature — Wright will plan before touching code…"
                : "Give Wright a task… (Enter to send, Shift+Enter for newline)"
          }
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <label className="plan-toggle" title="Draft a plan for approval before the agent edits anything">
            <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} />
            Plan
          </label>
          <select
            className="mode-select"
            title="Approval mode: how much the agent can do without asking"
            value={approvalMode}
            onChange={(e) => {
              const mode = e.target.value as typeof approvalMode;
              setApprovalMode(mode);
              post({ type: "setApprovalMode", mode });
            }}
          >
            <option value="manual">🔒 manual</option>
            <option value="auto-edit">✎ auto-edit</option>
            <option value="auto">⚡ auto</option>
          </select>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              post({ type: "setModel", model: e.target.value });
            }}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {busy ? (
            <button className="stop" onClick={() => post({ type: "stop" })}>
              ◼ Stop
            </button>
          ) : (
            <button className="send" onClick={send} disabled={!input.trim()}>
              Send ↩
            </button>
          )}
        </div>
        {sessionStats && <div className="session-stats">{sessionStats}</div>}
      </div>
    </div>
  );
}

function TextMessage(props: { role: "user" | "assistant"; html: string; streaming: boolean }) {
  return (
    <div className={`message ${props.role}`}>
      <div className="message-role">{props.role === "user" ? "You" : "Wright"}</div>
      <div
        className={`message-body${props.streaming ? " streaming" : ""}`}
        dangerouslySetInnerHTML={{ __html: props.html }}
      />
    </div>
  );
}

function ChangesPanel({ changes }: { changes: FileChangeItem[] }) {
  return (
    <div className="changes">
      <div className="changes-header">
        <span className="changes-title">
          Changes <span className="changes-count">{changes.length}</span>
        </span>
        <span className="changes-actions">
          <button onClick={() => post({ type: "keepAll" })}>Keep all</button>
          <button className="danger" onClick={() => post({ type: "revertAll" })}>
            Revert all
          </button>
        </span>
      </div>
      {changes.map((c) => (
        <div key={c.path} className="change-row">
          <span className={`change-kind ${c.kind}`}>{c.kind === "created" ? "A" : "M"}</span>
          <button className="change-path" title={`Open diff: ${c.path}`} onClick={() => post({ type: "openDiff", path: c.path })}>
            {c.path}
          </button>
          <button title="Keep this change" onClick={() => post({ type: "keepFile", path: c.path })}>
            ✓
          </button>
          <button className="danger" title="Revert this file" onClick={() => post({ type: "revertFile", path: c.path })}>
            ↩
          </button>
        </div>
      ))}
    </div>
  );
}

function ToolChip({ item }: { item: Extract<UiItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const statusIcon =
    item.status === "running" ? "⏳" : item.status === "ok" ? "✓" : item.status === "declined" ? "⃠" : "✗";
  return (
    <div className={`tool-chip ${item.status}`}>
      <button className="tool-header" onClick={() => setOpen((o) => !o)} title={item.argsSummary}>
        <span className="tool-icon">{TOOL_ICONS[item.name] ?? "⚒"}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-args">{item.argsSummary}</span>
        <span className={`tool-status ${item.status}`}>{statusIcon}</span>
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
    </div>
  );
}
