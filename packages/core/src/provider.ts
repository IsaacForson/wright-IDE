/**
 * Provider abstraction (Phase 1.2). NVIDIA is just one provider — the same
 * config shape covers Ollama, LM Studio, OpenAI, or anything else speaking
 * the OpenAI chat completions dialect.
 */

import { PROVIDER_CATALOG, type CatalogProvider } from "./providers/catalog.js";

export interface ProviderConfig {
  /** Stable identifier, e.g. "nvidia", "ollama". */
  id: string;
  /** Human-readable name for the UI. */
  name: string;
  /** OpenAI-compatible base URL, no trailing slash, e.g. https://integrate.api.nvidia.com/v1 */
  baseUrl: string;
  apiKey?: string;
  /** Optional key pool; the client rotates to the next on rate-limit/auth. */
  apiKeys?: string[];
  /** Whether the provider's models support tool/function calling. */
  supportsTools: boolean;
  /** Whether the provider exposes fill-in-middle (needed for autocomplete). */
  supportsFim: boolean;
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  defaultHeaders?: Record<string, string>;
  /** Default model ids by role; the router picks from these later. */
  models: {
    chat: string;
    fast?: string;
    embed?: string;
    fim?: string;
  };
}

export function nvidiaProvider(opts: {
  apiKey?: string;
  apiKeys?: string[];
  chatModel: string;
  fastModel?: string;
}): ProviderConfig {
  const keys = (opts.apiKeys?.length ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : []).filter(Boolean);
  return {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: keys[0],
    apiKeys: keys,
    supportsTools: true,
    supportsFim: false,
    models: {
      chat: opts.chatModel,
      fast: opts.fastModel,
    },
  };
}

export function openAICompatibleProvider(opts: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeys?: string[];
  chatModel: string;
  supportsTools?: boolean;
  supportsFim?: boolean;
  defaultHeaders?: Record<string, string>;
}): ProviderConfig {
  const keys = (opts.apiKeys?.length ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : []).filter(Boolean);
  return {
    id: opts.id,
    name: opts.name,
    baseUrl: opts.baseUrl.replace(/\/$/, ""),
    apiKey: keys[0],
    apiKeys: keys.length ? keys : undefined,
    supportsTools: opts.supportsTools ?? true,
    supportsFim: opts.supportsFim ?? false,
    defaultHeaders: opts.defaultHeaders,
    models: { chat: opts.chatModel },
  };
}

/**
 * Build a ModelClient-ready config from a catalog id + credentials.
 * Unknown ids fall back to a generic OpenAI-compatible shape using opts.baseUrl.
 */
export function buildProviderConfig(
  id: string,
  opts: {
    apiKey?: string;
    apiKeys?: string[];
    model: string;
    baseUrl?: string;
    name?: string;
    defaultHeaders?: Record<string, string>;
  },
): ProviderConfig {
  if (id === "nvidia") {
    return nvidiaProvider({
      apiKey: opts.apiKey,
      apiKeys: opts.apiKeys,
      chatModel: opts.model,
    });
  }
  const catalog: CatalogProvider | undefined = PROVIDER_CATALOG[id];
  return openAICompatibleProvider({
    id,
    name: opts.name ?? catalog?.name ?? id,
    baseUrl: opts.baseUrl ?? catalog?.baseUrl ?? "http://localhost:11434/v1",
    apiKey: opts.apiKey,
    apiKeys: opts.apiKeys,
    chatModel: opts.model,
    supportsTools: catalog?.supportsTools ?? true,
    defaultHeaders: opts.defaultHeaders ?? catalog?.defaultHeaders,
  });
}

export {
  PROVIDER_CATALOG,
  CLOUD_PROVIDER_IDS,
  parseModelRef,
  formatModelRef,
  MODEL_REF_PROVIDER_IDS,
} from "./providers/catalog.js";
export type { CatalogProvider, CloudProviderId } from "./providers/catalog.js";
