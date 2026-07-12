/**
 * Multi-provider config + failover chain builder for the extension.
 * Shared by chat agent, inline edit, and commit message.
 */

import * as vscode from "vscode";
import {
  CLOUD_PROVIDER_IDS,
  FailoverModelClient,
  ModelClient,
  PROVIDER_CATALOG,
  buildProviderConfig,
  formatModelRef,
  parseModelRef,
  type CloudProviderId,
  type FailoverTarget,
} from "@wright/core";
import { getConfig } from "./config.js";
import { ensureOllamaRunning, ollamaOpenAiBase } from "./ollama.js";

export interface CloudProviderState {
  id: CloudProviderId;
  name: string;
  enabled: boolean;
  apiKey: string | undefined;
  models: string[];
  signupHint: string;
  pickerHint: string;
}

export interface CustomFallbackProvider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Read enabled cloud providers with keys + model lists from settings. */
export function getCloudProviders(): CloudProviderState[] {
  const cfg = vscode.workspace.getConfiguration("wright");
  return CLOUD_PROVIDER_IDS.map((id) => {
    const catalog = PROVIDER_CATALOG[id]!;
    const enabled = cfg.get<boolean>(`providers.${id}.enabled`) ?? true;
    const apiKey = cfg.get<string>(`providers.${id}.apiKey`)?.trim() || undefined;
    const models = cfg.get<string[]>(`providers.${id}.models`)?.filter(Boolean) ?? catalog.suggestedModels;
    return {
      id,
      name: catalog.name,
      enabled,
      apiKey,
      models: models.length ? models : catalog.suggestedModels,
      signupHint: catalog.signupHint,
      pickerHint: catalog.pickerHint,
    };
  });
}

/** Providers that can actually be called (enabled + has api key). */
export function getReadyCloudProviders(): CloudProviderState[] {
  return getCloudProviders().filter((p) => p.enabled && !!p.apiKey);
}

export function getCustomFallbackProviders(): CustomFallbackProvider[] {
  const raw =
    vscode.workspace.getConfiguration("wright").get<CustomFallbackProvider[]>("fallback.providers") ?? [];
  return raw.filter((p) => p?.baseUrl && p?.model);
}

/**
 * Model ids for the chat picker: auto + NVIDIA list + prefixed cloud models
 * (only when a key is set) + ollama:* locals.
 */
export function buildPickerModels(nvidiaList: string[], localOllama: string[]): string[] {
  const cloud = getReadyCloudProviders().flatMap((p) =>
    p.models.map((m) => formatModelRef(p.id, m)),
  );
  return ["auto", ...nvidiaList, ...cloud, ...localOllama.map((m) => `ollama:${m}`)];
}

function onFailoverStatus(from: string, to: string): void {
  vscode.window.setStatusBarMessage(`Wright: ${from} unavailable → switched to ${to}`, 6_000);
}

function targetForCloud(p: CloudProviderState, model: string): FailoverTarget {
  return {
    name: p.name,
    model,
    client: new ModelClient(
      buildProviderConfig(p.id, { apiKey: p.apiKey, model }),
    ),
  };
}

function targetForNvidia(model: string): FailoverTarget {
  const config = getConfig();
  return {
    name: "nvidia",
    model,
    client: new ModelClient(
      buildProviderConfig("nvidia", { apiKeys: config.apiKeys, apiKey: config.apiKey, model }),
    ),
  };
}

function targetForCustom(p: CustomFallbackProvider): FailoverTarget {
  return {
    name: p.name || p.baseUrl,
    model: p.model,
    client: new ModelClient(
      buildProviderConfig(p.name || "custom", {
        apiKey: p.apiKey,
        model: p.model,
        baseUrl: p.baseUrl,
        name: p.name || "custom",
      }),
    ),
  };
}

async function targetForOllama(model: string, requireUp: boolean): Promise<FailoverTarget | undefined> {
  if (requireUp) {
    if (!(await ensureOllamaRunning())) return undefined;
  }
  return {
    name: "ollama (local)",
    model,
    client: new ModelClient(
      buildProviderConfig("ollama", {
        model,
        baseUrl: ollamaOpenAiBase(),
        name: "Ollama",
      }),
    ),
  };
}

/**
 * Build an ordered failover client for a picker model ref (`auto`, bare NIM id,
 * `groq:…`, `ollama:…`, etc.).
 */
export async function buildFailoverClient(
  modelRef: string,
  opts: { requireOllamaIfPrimary?: boolean } = {},
): Promise<{ client: FailoverModelClient; agentModel: string; targets: FailoverTarget[] }> {
  const config = getConfig();
  const wcfg = vscode.workspace.getConfiguration("wright");
  const ollamaFallback = wcfg.get<boolean>("fallback.ollama") ?? true;
  const ollamaFallbackModel = wcfg.get<string>("fallback.ollamaModel") || "qwen2.5-coder:14b";
  const ready = getReadyCloudProviders();
  const customs = getCustomFallbackProviders();
  const targets: FailoverTarget[] = [];

  // Resolve "auto" to the configured NVIDIA chat model (bare id).
  const resolvedRef = modelRef === "auto" ? config.chatModel : modelRef;
  const { providerId, model } = parseModelRef(resolvedRef);
  let agentModel = model;

  if (providerId === "ollama") {
    agentModel = model;
    const primary = await targetForOllama(agentModel, opts.requireOllamaIfPrimary !== false);
    if (!primary) {
      throw new Error("Ollama isn't reachable — install/start it (or fix wright.ollama.url), or pick a cloud model.");
    }
    targets.push(primary);
    if (config.apiKeys.length) targets.push(targetForNvidia(config.chatModel));
    for (const p of ready) targets.push(targetForCloud(p, p.models[0]!));
    for (const p of customs) targets.push(targetForCustom(p));
  } else if (providerId === "nvidia") {
    agentModel = model;
    targets.push(targetForNvidia(agentModel));
    for (const p of ready) targets.push(targetForCloud(p, p.models[0]!));
    for (const p of customs) targets.push(targetForCustom(p));
    if (ollamaFallback) {
      const ol = await targetForOllama(ollamaFallbackModel, false);
      if (ol) targets.push(ol);
    }
  } else {
    // Named cloud provider as primary.
    const primary = ready.find((p) => p.id === providerId);
    if (!primary) {
      throw new Error(
        `Wright: provider "${providerId}" is not enabled or has no API key. Open Wright Settings → Providers.`,
      );
    }
    agentModel = model;
    targets.push(targetForCloud(primary, agentModel));
    if (config.apiKeys.length) targets.push(targetForNvidia(config.chatModel));
    for (const p of ready) {
      if (p.id === providerId) continue;
      targets.push(targetForCloud(p, p.models[0]!));
    }
    for (const p of customs) targets.push(targetForCustom(p));
    if (ollamaFallback) {
      const ol = await targetForOllama(ollamaFallbackModel, false);
      if (ol) targets.push(ol);
    }
  }

  if (targets.length === 0) {
    throw new Error("Wright: no providers configured. Add an API key in Wright Settings.");
  }

  const client = new FailoverModelClient(targets, onFailoverStatus);
  return { client, agentModel, targets };
}

/** True if any cloud or NVIDIA key can serve a request. */
export function hasAnyCloudCredential(): boolean {
  const config = getConfig();
  return config.apiKeys.length > 0 || getReadyCloudProviders().length > 0;
}
