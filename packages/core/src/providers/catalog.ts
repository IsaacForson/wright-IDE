/**
 * Built-in OpenAI-compatible provider catalog. NVIDIA is the default (bare
 * model ids); everything else is selected as `providerId:modelId` in the picker.
 *
 * Cloud defaults are curated for coding + general reasoning on free tiers —
 * not every free model, only ones strong enough for agent work.
 */

export interface CatalogProvider {
  id: string;
  name: string;
  /** OpenAI-compatible base URL, no trailing slash. */
  baseUrl: string;
  supportsTools: boolean;
  /** Extra request headers (e.g. OpenRouter attribution). */
  defaultHeaders?: Record<string, string>;
  /** Curated free / tool-capable models shown when the provider has a key. */
  suggestedModels: string[];
  /** Short hint for Settings / picker. */
  signupHint: string;
  /** Display hint in the model picker (e.g. "free · many models"). */
  pickerHint: string;
}

/** Cloud providers that use wright.providers.<id>.* settings (not nvidia/ollama). */
export const CLOUD_PROVIDER_IDS = [
  "openrouter",
  "deepseek",
  "groq",
  "gemini",
  "cerebras",
  "mistral",
] as const;

export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

export const PROVIDER_CATALOG: Record<string, CatalogProvider> = {
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    supportsTools: true,
    suggestedModels: [],
    signupHint: "Get a key at build.nvidia.com",
    pickerHint: "NIM",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    supportsTools: true,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/IsaacForson/wright-IDE",
      "X-Title": "Wright",
    },
    // Free :free variants that are actually strong at coding / agent reasoning.
    suggestedModels: [
      "qwen/qwen3-coder:free",
      "deepseek/deepseek-chat-v3-0324:free",
      "deepseek/deepseek-r1-0528:free",
    ],
    signupHint: "Free key at openrouter.ai — curated :free coding models (Qwen3-Coder, DeepSeek)",
    pickerHint: "openrouter · free coding",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    supportsTools: true,
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    signupHint: "API key at platform.deepseek.com — among the strongest free/cheap coding + reasoning models",
    pickerHint: "deepseek · coding",
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsTools: true,
    suggestedModels: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"],
    signupHint: "Free key at console.groq.com — Llama 3.3 70B / Qwen3 at very high speed",
    pickerHint: "groq · fast coding",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsTools: true,
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
    signupHint: "Free key at aistudio.google.com — strongest free reasoning loop + huge context",
    pickerHint: "gemini · reasoning",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    supportsTools: true,
    suggestedModels: ["llama-3.3-70b", "qwen-3-32b"],
    signupHint: "Free key at cloud.cerebras.ai — Llama 3.3 70B at extreme throughput",
    pickerHint: "cerebras · fastest",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    supportsTools: true,
    suggestedModels: ["codestral-latest", "mistral-large-latest"],
    signupHint: "Free Experiment tier at console.mistral.ai — Codestral for code, Large for reasoning",
    pickerHint: "mistral · codestral",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    supportsTools: true,
    suggestedModels: [],
    signupHint: "Local / remote Ollama — no cloud key",
    pickerHint: "local · free",
  },
};

/** All ids that may appear as a `provider:` prefix in a model ref. */
export const MODEL_REF_PROVIDER_IDS = new Set([
  "nvidia",
  "ollama",
  ...CLOUD_PROVIDER_IDS,
]);

/**
 * Parse a picker model id. Bare ids (no known prefix) are NVIDIA.
 * `openrouter:deepseek/foo:free` → provider openrouter, model deepseek/foo:free.
 */
export function parseModelRef(ref: string): { providerId: string; model: string } {
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const prefix = ref.slice(0, colon);
    if (MODEL_REF_PROVIDER_IDS.has(prefix)) {
      return { providerId: prefix, model: ref.slice(colon + 1) };
    }
  }
  return { providerId: "nvidia", model: ref };
}

/** Build a picker id: nvidia stays bare; others become `id:model`. */
export function formatModelRef(providerId: string, model: string): string {
  if (providerId === "nvidia") return model;
  return `${providerId}:${model}`;
}
