/**
 * Built-in OpenAI-compatible provider catalog. NVIDIA is the default (bare
 * model ids); everything else is selected as `providerId:modelId` in the picker.
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
  "groq",
  "gemini",
  "cerebras",
  "huggingface",
  "github",
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
    suggestedModels: [
      "deepseek/deepseek-chat-v3-0324:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen3-32b:free",
    ],
    signupHint: "Free key at openrouter.ai — 300+ models, many :free",
    pickerHint: "openrouter · free tier",
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    supportsTools: true,
    suggestedModels: ["llama-3.3-70b-versatile", "qwen/qwen3-32b", "openai/gpt-oss-120b"],
    signupHint: "Free key at console.groq.com — very fast LPU inference",
    pickerHint: "groq · fast",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsTools: true,
    suggestedModels: ["gemini-2.0-flash", "gemini-2.5-flash"],
    signupHint: "Free key at aistudio.google.com",
    pickerHint: "gemini · free tier",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    supportsTools: true,
    suggestedModels: ["llama-3.3-70b", "qwen-3-32b"],
    signupHint: "Free key at cloud.cerebras.ai",
    pickerHint: "cerebras · fastest",
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    supportsTools: true,
    suggestedModels: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3",
    ],
    signupHint: "Free monthly credits at huggingface.co/settings/tokens",
    pickerHint: "huggingface · router",
  },
  github: {
    id: "github",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    supportsTools: true,
    suggestedModels: ["gpt-4o-mini", "gpt-4o", "Phi-4"],
    signupHint: "Free with your GitHub account — github.com/marketplace/models",
    pickerHint: "github · free",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    supportsTools: true,
    suggestedModels: ["mistral-small-latest", "mistral-medium-latest"],
    signupHint: "Free tier at console.mistral.ai",
    pickerHint: "mistral",
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
