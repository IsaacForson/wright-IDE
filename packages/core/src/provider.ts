/**
 * Provider abstraction (Phase 1.2). NVIDIA is just one provider — the same
 * config shape covers Ollama, LM Studio, OpenAI, or anything else speaking
 * the OpenAI chat completions dialect.
 */

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
  chatModel: string;
  supportsTools?: boolean;
  supportsFim?: boolean;
}): ProviderConfig {
  return {
    id: opts.id,
    name: opts.name,
    baseUrl: opts.baseUrl.replace(/\/$/, ""),
    apiKey: opts.apiKey,
    supportsTools: opts.supportsTools ?? true,
    supportsFim: opts.supportsFim ?? false,
    models: { chat: opts.chatModel },
  };
}
