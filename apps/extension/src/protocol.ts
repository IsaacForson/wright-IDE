/**
 * Message protocol between the extension host and the chat webview.
 * Imported by both sides (types only — no runtime coupling).
 */

export type ChatMode = "agent" | "plan" | "debug" | "ask" | "multi";
export type ResearchMode = "off" | "websearch" | "research" | "deep";

/** A non-image file attached as reference context. */
export interface FileAttachment {
  /** Display name (basename). */
  name: string;
  /** Workspace-relative or absolute path, when the file exists on disk. */
  path?: string;
  /** Inline content for files dropped from outside the workspace. */
  content?: string;
}

/** Webview → extension */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string; mode: ChatMode; research: ResearchMode; images?: string[]; files?: FileAttachment[] }
  | { type: "openSettings" }
  | { type: "executePlan" }
  | { type: "discardPlan" }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setModel"; model: string }
  | { type: "setApprovalMode"; mode: "manual" | "auto-edit" | "auto" }
  | { type: "queryFiles"; query: string; token: number }
  | { type: "planDecision"; usePlan: boolean }
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
  | { kind: "text"; role: "user" | "assistant"; content: string; images?: string[]; files?: string[] }
  | { kind: "thinking"; content: string; seconds: number }
  | { kind: "tool"; id: string; name: string; argsSummary: string; status: "running" | "ok" | "error" | "declined"; output?: string };

/** Extension → webview */
export type HostToWebview =
  | {
      type: "state";
      items: UiItem[];
      model: string;
      models: string[];
      busy: boolean;
      changes: FileChangeItem[];
      planPending: boolean;
      approvalMode: "manual" | "auto-edit" | "auto";
      sessionStats?: string;
      defaultMode: ChatMode;
    }
  | { type: "attachSelection"; file: FileAttachment }
  | { type: "planReady" }
  | { type: "planSuggest" }
  | { type: "assistantStart" }
  | { type: "delta"; text: string }
  | { type: "thinkingDelta"; text: string }
  | { type: "thinkingDone"; seconds: number }
  | { type: "toolStart"; id: string; name: string; argsSummary: string }
  | { type: "toolDone"; id: string; status: "ok" | "error" | "declined"; output: string }
  | { type: "changes"; changes: FileChangeItem[] }
  | { type: "fileList"; token: number; entries: Array<{ path: string; type: "file" | "dir" }> }
  | { type: "turnDone"; stats?: string }
  | { type: "error"; message: string };
