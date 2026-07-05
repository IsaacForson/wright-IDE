import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WrightConfig {
  apiKey: string | undefined;
  chatModel: string;
  fastModel: string;
  embedModel: string;
}

/**
 * API key resolution order: VS Code setting → NVIDIA_API_KEY env var →
 * `.env` at the workspace root. The .env fallback keeps dev friction low
 * (same file the CLI uses); the setting is the "real" home for it.
 */
export function getConfig(): WrightConfig {
  const cfg = vscode.workspace.getConfiguration("wright");
  const settingKey = cfg.get<string>("nvidia.apiKey")?.trim();
  return {
    apiKey: settingKey || process.env.NVIDIA_API_KEY || readWorkspaceDotEnv("NVIDIA_API_KEY"),
    chatModel: cfg.get<string>("model.chat") || "z-ai/glm-5.2",
    fastModel: cfg.get<string>("model.fast") || "meta/llama-3.1-8b-instruct",
    embedModel: cfg.get<string>("model.embed") || "nvidia/nv-embedcode-7b-v1",
  };
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
