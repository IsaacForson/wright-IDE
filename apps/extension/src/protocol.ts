/**
 * Message protocol between the extension host and the chat webview.
 * Imported by both sides (types only — no runtime coupling).
 */

/** Webview → extension */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setModel"; model: string }
  | { type: "openDiff"; path: string }
  | { type: "keepFile"; path: string }
  | { type: "revertFile"; path: string }
  | { type: "keepAll" }
  | { type: "revertAll" };

/** A pending (revertible) file change from the agent. */
export interface FileChangeItem {
  path: string;
  kind: "edited" | "created";
}

/** One entry in the rendered transcript. */
export type UiItem =
  | { kind: "text"; role: "user" | "assistant"; content: string }
  | { kind: "tool"; id: string; name: string; argsSummary: string; status: "running" | "ok" | "error" | "declined"; output?: string };

/** Extension → webview */
export type HostToWebview =
  | { type: "state"; items: UiItem[]; model: string; models: string[]; busy: boolean; changes: FileChangeItem[] }
  | { type: "assistantStart" }
  | { type: "delta"; text: string }
  | { type: "toolStart"; id: string; name: string; argsSummary: string }
  | { type: "toolDone"; id: string; status: "ok" | "error" | "declined"; output: string }
  | { type: "changes"; changes: FileChangeItem[] }
  | { type: "turnDone"; stats?: string }
  | { type: "error"; message: string };
