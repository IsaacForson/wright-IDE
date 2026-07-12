import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ApprovalMode } from "@wright/core";

export type PermissionDefault = "always-ask" | "allow-once" | "allow-always";

export interface WrightConfig {
  apiKey: string | undefined;
  /** Full key pool for automatic rotation on rate limits. */
  apiKeys: string[];
  chatModel: string;
  fastModel: string;
  embedModel: string;
  visionModel: string;
  webSearch: { provider: "tavily" | "brave" | "duckduckgo"; apiKey: string | undefined };
  approvalMode: ApprovalMode;
  /** Default stance for the in-chat permission card. */
  permissionDefault: PermissionDefault;
  commandRunTarget: "terminal" | "sandbox";
  /** USD per 1M tokens; 0 disables the cost estimate. */
  priceInPer1M: number;
  priceOutPer1M: number;
  /** Models shown in the picker (user-editable). */
  modelList: string[];
  /** Mode the chat starts in. */
  defaultMode: "agent" | "plan" | "debug" | "ask" | "multi";
  /** Automatically keep all agent edits after each turn. */
  autoKeep: boolean;
  /** User rules from Settings → Rules (composed text for the system prompt). */
  userRules?: string;
  /** Always ask before delete-like shell commands. */
  requireDeleteApproval: boolean;
}

export const DEFAULT_MODEL_LIST = [
  "z-ai/glm-5.2",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "deepseek-ai/deepseek-v4-pro",
  "moonshotai/kimi-k2.6",
  "nvidia/nemotron-3-super-120b-a12b",
  "qwen/qwen3.5-122b-a10b",
  "minimaxai/minimax-m3",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-8b-instruct",
];

/**
 * API key resolution order: VS Code setting → NVIDIA_API_KEY env var →
 * `.env` at the workspace root. The .env fallback keeps dev friction low
 * (same file the CLI uses); the setting is the "real" home for it.
 */
export function getConfig(): WrightConfig {
  const cfg = vscode.workspace.getConfiguration("wright");
  const settingKey = cfg.get<string>("nvidia.apiKey")?.trim();
  const settingKeys = (cfg.get<string[]>("nvidia.apiKeys") ?? []).map((k) => k.trim()).filter(Boolean);
  const envKeys = (process.env.NVIDIA_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  // Pool: single key + array setting + comma-env + .env fallback, de-duplicated.
  const pool = [
    ...(settingKey ? [settingKey] : []),
    ...settingKeys,
    ...envKeys,
    ...(process.env.NVIDIA_API_KEY ? [process.env.NVIDIA_API_KEY] : []),
    ...(readWorkspaceDotEnv("NVIDIA_API_KEY") ? [readWorkspaceDotEnv("NVIDIA_API_KEY")!] : []),
  ].filter((k, i, a) => k && a.indexOf(k) === i);
  return {
    apiKey: pool[0],
    apiKeys: pool,
    chatModel: cfg.get<string>("model.chat") || "z-ai/glm-5.2",
    fastModel: cfg.get<string>("model.fast") || "meta/llama-3.1-8b-instruct",
    embedModel: cfg.get<string>("model.embed") || "nvidia/nv-embedcode-7b-v1",
    visionModel: cfg.get<string>("model.vision") || "meta/llama-4-maverick-17b-128e-instruct",
    webSearch: {
      provider: (cfg.get<string>("webSearch.provider") as "tavily" | "brave" | "duckduckgo") || "duckduckgo",
      apiKey: cfg.get<string>("webSearch.apiKey")?.trim() || undefined,
    },
    approvalMode: (cfg.get<string>("approvalMode") as ApprovalMode) || "auto-edit",
    permissionDefault: (cfg.get<string>("permissionDefault") as PermissionDefault) || "always-ask",
    commandRunTarget: (cfg.get<string>("commandRunTarget") as "terminal" | "sandbox") || "terminal",
    priceInPer1M: cfg.get<number>("pricing.inputPer1M") ?? 0,
    priceOutPer1M: cfg.get<number>("pricing.outputPer1M") ?? 0,
    modelList: cfg.get<string[]>("models.list")?.filter(Boolean) ?? DEFAULT_MODEL_LIST,
    defaultMode: (cfg.get<string>("defaultMode") as WrightConfig["defaultMode"]) || "agent",
    autoKeep: cfg.get<boolean>("edits.autoKeep") ?? false,
    userRules: composeUserRules(cfg),
    requireDeleteApproval: cfg.get<boolean>("rules.requireDeleteApproval") ?? true,
  };
}

/** Build the Settings → Rules block injected into the agent system prompt. */
export function composeUserRules(cfg = vscode.workspace.getConfiguration("wright")): string | undefined {
  const parts: string[] = [];
  if (cfg.get<boolean>("rules.alwaysAskFollowUps")) {
    parts.push(
      "- When you need the user to choose before you can proceed, call ask_user — that is the signal for selectable answer chips. Do not write those questions as markdown. Do not ask after you already fully answered. Do not turn summaries or file contents into options.",
    );
  }
  if (cfg.get<boolean>("rules.requireDeleteApproval") ?? true) {
    parts.push(
      "- Never delete files, folders, or wipe data without explicit user confirmation in this conversation. Prefer asking first; do not run destructive rm/rmdir/del commands on your own initiative.",
    );
  }
  if (cfg.get<boolean>("rules.noDriveByRefactors") ?? true) {
    parts.push(
      "- Only change what was asked. Do not refactor, rename, or “clean up” unrelated code, formatting, or files.",
    );
  }
  if (cfg.get<boolean>("rules.explainBeforeEdits")) {
    parts.push("- Before editing or creating files, briefly state what you plan to change and why (one or two sentences).");
  }
  for (const item of cfg.get<string[]>("rules.items") ?? []) {
    const t = item.trim().replace(/^[-*•]\s*/, "");
    if (t) parts.push(`- ${t}`);
  }
  const custom = cfg.get<string>("rules.custom")?.trim();
  if (custom) parts.push(custom);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, 12_000);
}

function readWorkspaceDotEnv(key: string): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const raw = readFileSync(join(folder.uri.fsPath, ".env"), "utf8");
      const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, "m"));
      if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
    } catch {
      // no .env in this folder
    }
  }
  return undefined;
}
