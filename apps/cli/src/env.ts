import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tiny .env loader — reads the repo-root .env without a dotenv dependency.
 * Real env vars win over .env values.
 */
function loadDotEnv(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key && process.env[key] === undefined) {
      process.env[key] = value!.replace(/^["']|["']$/g, "");
    }
  }
}

loadDotEnv();

export interface Env {
  apiKey: string;
  model: string;
  fastModel?: string;
}

export function requireEnv(): Env {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing NVIDIA_API_KEY.\n" +
        "  1. Get a key at https://build.nvidia.com\n" +
        "  2. cp .env.example .env and paste it in\n",
    );
    process.exit(1);
  }
  return {
    apiKey,
    model: process.env.NVIDIA_MODEL ?? "z-ai/glm-5.2",
    fastModel: process.env.NVIDIA_FAST_MODEL,
  };
}
