import * as vscode from "vscode";
import { DEFAULT_MODEL_LIST } from "./config.js";

/**
 * Cursor-style settings editor: a full-page webview with a section sidebar,
 * writing straight to the `wright.*` VS Code configuration. Works identically
 * in the Wright IDE and in the standalone extension.
 */

type FieldKind = "toggle" | "select" | "text" | "password" | "number" | "stringlist" | "json";

interface Field {
  key: string; // configuration key relative to configSection (default "wright")
  label: string;
  desc: string;
  kind: FieldKind;
  options?: string[]; // for select
  placeholder?: string;
  /** select options come from the current models.list value */
  optionsFromModelList?: boolean;
  /** VS Code config section (default "wright") */
  configSection?: string;
  /** For toggles: UI on means the stored boolean is false (e.g. chat.disableAIFeatures) */
  invert?: boolean;
}

interface Section {
  id: string;
  title: string;
  icon: string; // codicon name
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    id: "general",
    title: "General",
    icon: "settings-gear",
    fields: [
      {
        key: "defaultMode", label: "Default Mode", kind: "select",
        options: ["agent", "plan", "debug", "ask", "multi"],
        desc: "Mode the chat starts in",
      },
      {
        key: "approvalMode", label: "Approval Mode", kind: "select",
        options: ["manual", "auto-edit", "auto"],
        desc: "How much the agent can do without asking. manual: approve everything · auto-edit: edits run, commands ask · auto: everything runs except deny-listed actions",
      },
      {
        key: "edits.autoKeep", label: "Auto-keep Edits", kind: "toggle",
        desc: "Automatically keep all agent edits after each turn (skip the manual Keep all)",
      },
      {
        key: "disableAIFeatures",
        configSection: "chat",
        invert: true,
        label: "Built-in IDE Chat",
        kind: "toggle",
        desc: "Show the host Chat icon in the right sidebar next to Wright. Off hides built-in chat (Wright stays on the right)",
      },
    ],
  },
  {
    id: "models",
    title: "Models",
    icon: "chip",
    fields: [
      { key: "model.chat", label: "Default Chat Model (NVIDIA)", kind: "select", optionsFromModelList: true, desc: "Used for Auto and as NVIDIA's failover model. Prefer picking a provider model in the chat picker for primary" },
      { key: "model.fast", label: "Fast Model (NVIDIA)", kind: "select", optionsFromModelList: true, desc: "Cheap/fast NVIDIA model for inline edit and commit messages when no other provider is selected" },
      { key: "model.vision", label: "Vision Model", kind: "select", options: ["meta/llama-4-maverick-17b-128e-instruct", "meta/llama-3.2-90b-vision-instruct"], desc: "Multimodal model used when a chat message includes an image (NVIDIA)" },
      { key: "model.embed", label: "Embedding Model", kind: "select", options: ["nvidia/nv-embedcode-7b-v1"], desc: "Embedding model for codebase indexing — still NVIDIA for this release" },
    ],
  },
  {
    id: "keys",
    title: "NVIDIA",
    icon: "key",
    fields: [
      { key: "nvidia.apiKey", label: "NVIDIA API Key", kind: "password", placeholder: "nvapi-…", desc: "From build.nvidia.com. If empty, Wright falls back to the NVIDIA_API_KEY env var, then a .env at the workspace root. Bare model ids in the picker use NVIDIA." },
      { key: "nvidia.apiKeys", label: "Additional Keys (rotation)", kind: "stringlist", desc: "Extra keys rotated automatically when a request hits a rate limit (429). Add several free-tier keys to raise effective throughput" },
      { key: "models.list", label: "NVIDIA Models in Picker", kind: "stringlist", desc: "NVIDIA NIM model ids shown in the chat picker (unprefixed)" },
    ],
  },
  {
    id: "providers",
    title: "Providers",
    icon: "cloud",
    fields: [
      { key: "providers.openrouter.enabled", label: "OpenRouter", kind: "toggle", desc: "Free key at openrouter.ai — Laguna / gpt-oss / Nemotron (DeepSeek & Qwen :free are dead/retiring)" },
      { key: "providers.openrouter.apiKey", label: "OpenRouter API Key", kind: "password", placeholder: "sk-or-…", desc: "Required to use OpenRouter as primary or failover" },
      { key: "providers.openrouter.models", label: "OpenRouter Models", kind: "stringlist", desc: "Free coding models for the picker (must still be $0 — check openrouter.ai/models)" },
      { key: "providers.deepseek.enabled", label: "DeepSeek", kind: "toggle", desc: "platform.deepseek.com — among the strongest coding + reasoning APIs" },
      { key: "providers.deepseek.apiKey", label: "DeepSeek API Key", kind: "password", placeholder: "sk-…", desc: "Required to use DeepSeek as primary or failover" },
      { key: "providers.deepseek.models", label: "DeepSeek Models", kind: "stringlist", desc: "deepseek-chat (coding) · deepseek-reasoner (hard reasoning)" },
      { key: "providers.groq.enabled", label: "Groq", kind: "toggle", desc: "Free key at console.groq.com — Llama 3.3 70B / Qwen3 at very high speed" },
      { key: "providers.groq.apiKey", label: "Groq API Key", kind: "password", placeholder: "gsk_…", desc: "Required to use Groq as primary or failover" },
      { key: "providers.groq.models", label: "Groq Models", kind: "stringlist", desc: "Model ids for the picker" },
      { key: "providers.gemini.enabled", label: "Google Gemini", kind: "toggle", desc: "Free key at aistudio.google.com — use 3.5 Flash (2.5 blocked for new keys; Pro is paid-only)" },
      { key: "providers.gemini.apiKey", label: "Gemini API Key", kind: "password", placeholder: "AIza…", desc: "Required to use Gemini as primary or failover" },
      { key: "providers.gemini.models", label: "Gemini Models", kind: "stringlist", desc: "Prefer gemini-3.5-flash / gemini-3.1-flash-lite" },
      { key: "providers.cerebras.enabled", label: "Cerebras", kind: "toggle", desc: "Free key at cloud.cerebras.ai — gpt-oss-120b / GLM 4.7 (Llama 3.3 / Qwen 3 deprecated)" },
      { key: "providers.cerebras.apiKey", label: "Cerebras API Key", kind: "password", placeholder: "csk-…", desc: "Required to use Cerebras as primary or failover" },
      { key: "providers.cerebras.models", label: "Cerebras Models", kind: "stringlist", desc: "Prefer gpt-oss-120b — llama-3.3-70b / qwen-3-32b were removed" },
      { key: "providers.mistral.enabled", label: "Mistral", kind: "toggle", desc: "Experiment tier at console.mistral.ai — Codestral for code, Large for reasoning" },
      { key: "providers.mistral.apiKey", label: "Mistral API Key", kind: "password", placeholder: "…", desc: "Required to use Mistral as primary or failover" },
      { key: "providers.mistral.models", label: "Mistral Models", kind: "stringlist", desc: "codestral-latest · mistral-large-latest" },
      { key: "fallback.providers", label: "Custom OpenAI-compatible", kind: "json", desc: 'Extra providers not in the catalog, appended to the failover chain. Example: [{"name":"my-proxy","baseUrl":"https://…/v1","apiKey":"…","model":"llama-3.3-70b"}]' },
    ],
  },
  {
    id: "fallbacks",
    title: "Local (Ollama)",
    icon: "server",
    fields: [
      { key: "fallback.ollama", label: "Ollama Fallback", kind: "toggle", desc: "When every cloud provider is unavailable, fall back to local Ollama" },
      { key: "fallback.ollamaModel", label: "Ollama Fallback Model", kind: "text", placeholder: "qwen2.5-coder:14b", desc: "Must support tool calling for agent work" },
      { key: "ollama.url", label: "Ollama Server URL", kind: "text", placeholder: "http://localhost:11434", desc: "Point at a remote Ollama (e.g. a rented GPU box) to run big local models off-machine" },
    ],
  },
  {
    id: "autocomplete",
    title: "Autocomplete",
    icon: "lightbulb-autofix",
    fields: [
      { key: "autocomplete.enabled", label: "Tab Completions", kind: "toggle", desc: "Ghost-text completions via a local Ollama FIM model (never uses NVIDIA quota). Silently inactive if Ollama isn't running" },
      { key: "autocomplete.model", label: "Completion Model", kind: "text", placeholder: "qwen2.5-coder:14b", desc: "Ollama model for autocomplete. Must support fill-in-middle" },
      { key: "autocomplete.ollamaUrl", label: "Ollama URL", kind: "text", placeholder: "http://localhost:11434", desc: "Base URL of the Ollama server used for completions" },
    ],
  },
  {
    id: "websearch",
    title: "Web Search",
    icon: "globe",
    fields: [
      { key: "webSearch.provider", label: "Provider", kind: "select", options: ["duckduckgo", "tavily", "brave"], desc: "duckduckgo: keyless, well-known topics only · tavily / brave: full web search, key required" },
      { key: "webSearch.apiKey", label: "Search API Key", kind: "password", desc: "API key for Tavily or Brave. Not needed for DuckDuckGo" },
    ],
  },
  {
    id: "mcp",
    title: "Tools & MCP",
    icon: "tools",
    fields: [
      { key: "mcp.servers", label: "MCP Servers", kind: "json", desc: 'Model Context Protocol servers whose tools the agent can use. Example: {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}' },
    ],
  },
  {
    id: "usage",
    title: "Usage & Pricing",
    icon: "graph",
    fields: [
      { key: "pricing.inputPer1M", label: "Input $ / 1M tokens", kind: "number", desc: "For the session cost estimate. 0 = show token counts only" },
      { key: "pricing.outputPer1M", label: "Output $ / 1M tokens", kind: "number", desc: "For the session cost estimate. 0 = show token counts only" },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);
const FIELD_BY_KEY = new Map(ALL_FIELDS.map((f) => [f.key, f]));

export class WrightSettingsPanel {
  private static current: WrightSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri): void {
    if (WrightSettingsPanel.current) {
      WrightSettingsPanel.current.panel.reveal();
      return;
    }
    WrightSettingsPanel.current = new WrightSettingsPanel(extensionUri);
  }

  private constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "wright.settings",
      "Wright Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "wright.svg");
    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { type: string; key?: string; value?: unknown }) => {
        if (msg.type === "ready") this.postValues();
        if (msg.type === "set" && msg.key) void this.set(msg.key, msg.value);
        if (msg.type === "openVSCodeSettings") void vscode.commands.executeCommand("workbench.action.openSettings", "wright");
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("wright") || e.affectsConfiguration("chat.disableAIFeatures")) {
          this.postValues();
        }
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async set(key: string, value: unknown): Promise<void> {
    const field = FIELD_BY_KEY.get(key);
    const section = field?.configSection ?? "wright";
    let stored = value;
    if (field?.invert && typeof value === "boolean") stored = !value;
    try {
      await vscode.workspace.getConfiguration(section).update(key, stored, vscode.ConfigurationTarget.Global);
      if (section === "chat" && key === "disableAIFeatures") {
        const enabling = stored === false;
        if (enabling) {
          // Make sure the right sidebar is visible and open the host Chat view.
          try {
            await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
            await vscode.commands.executeCommand("workbench.action.chat.open");
          } catch {
            try {
              await vscode.commands.executeCommand("workbench.panel.chat.view.copilot.focus");
            } catch {
              /* host chat command names vary by IDE */
            }
          }
        }
        const choice = await vscode.window.showInformationMessage(
          enabling
            ? "Built-in IDE chat enabled — it should appear as a Chat icon on the right, next to Wright. Reload if you still don't see it."
            : "Built-in IDE chat hidden. Wright stays on the right. Reload if the Chat icon is still visible.",
          "Reload Window",
          "Reset View Layout",
        );
        if (choice === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else if (choice === "Reset View Layout") {
          await vscode.commands.executeCommand("workbench.action.resetViewLocations");
          await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
          await vscode.commands.executeCommand("wright.chat.focus");
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Wright: failed to save ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private postValues(): void {
    const values: Record<string, unknown> = {};
    for (const field of ALL_FIELDS) {
      const section = field.configSection ?? "wright";
      let v = vscode.workspace.getConfiguration(section).get(field.key);
      if (field.invert && typeof v === "boolean") v = !v;
      values[field.key] = v;
    }
    if (!Array.isArray(values["models.list"]) || (values["models.list"] as string[]).length === 0) {
      values["models.list"] = DEFAULT_MODEL_LIST;
    }
    void this.panel.webview.postMessage({ type: "config", values });
  }

  private dispose(): void {
    WrightSettingsPanel.current = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private render(): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; display: flex; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px;
  }
  nav {
    width: 210px; flex: none; padding: 18px 8px; overflow-y: auto;
    border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  }
  nav h1 { font-size: 15px; font-weight: 600; margin: 0 10px 14px; }
  nav button {
    display: block; width: 100%; text-align: left; padding: 6px 10px; margin: 1px 0;
    border: none; border-radius: 5px; background: transparent; cursor: pointer;
    color: var(--vscode-foreground); font-size: 13px; font-family: inherit;
  }
  nav button:hover { background: var(--vscode-list-hoverBackground); }
  nav button.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  nav .foot { margin-top: 18px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding-top: 10px; }
  nav .foot button { opacity: .75; font-size: 12px; }
  main { flex: 1; overflow-y: auto; padding: 26px 34px 60px; }
  section { display: none; max-width: 720px; }
  section.active { display: block; }
  section > h2 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
  section > p.sub { margin: 0 0 18px; opacity: .6; }
  .row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
    padding: 14px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.12));
  }
  .row .meta { flex: 1; min-width: 0; }
  .row .label { font-weight: 500; margin-bottom: 3px; }
  .row .desc { opacity: .6; font-size: 12px; line-height: 1.5; }
  .row .control { flex: none; width: 260px; display: flex; justify-content: flex-end; align-items: center; }
  .row .control.wide { width: 100%; }
  .row.stacked { flex-direction: column; gap: 8px; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width: 100%; padding: 5px 8px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; font-size: 12.5px;
  }
  textarea { font-family: var(--vscode-editor-font-family, monospace); min-height: 96px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .switch { position: relative; width: 36px; height: 20px; flex: none; cursor: pointer; }
  .switch input { display: none; }
  .switch .track { position: absolute; inset: 0; border-radius: 20px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); transition: background .15s; }
  .switch .thumb { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--vscode-foreground); opacity: .7; transition: transform .15s; }
  .switch input:checked + .track { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .switch input:checked + .track + .thumb { transform: translateX(16px); background: var(--vscode-button-foreground); opacity: 1; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
  .tag {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 4px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 12px;
  }
  .tag button { border: none; background: none; color: inherit; cursor: pointer; padding: 0; font-size: 13px; line-height: 1; opacity: .7; }
  .tag button:hover { opacity: 1; }
  .tags input { flex: 1 1 160px; min-width: 140px; }
  .json-status { font-size: 11px; margin-top: 4px; }
  .json-status.err { color: var(--vscode-errorForeground); }
  .json-status.ok { color: var(--vscode-testing-iconPassed, #73c991); opacity: .8; }
  .saved-flash { position: fixed; bottom: 18px; right: 22px; padding: 6px 12px; border-radius: 5px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .saved-flash.show { opacity: 1; }
</style>
</head>
<body>
  <nav>
    <h1>Wright Settings</h1>
    <div id="nav"></div>
    <div class="foot"><button id="openRaw">Open in VS Code Settings</button></div>
  </nav>
  <main id="main"></main>
  <div class="saved-flash" id="flash">Saved</div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const SECTIONS = ${JSON.stringify(SECTIONS)};
  let values = {};
  let flashTimer;

  function flash() {
    const el = document.getElementById("flash");
    el.classList.add("show");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("show"), 1200);
  }
  function save(key, value) {
    values[key] = value;
    vscodeApi.postMessage({ type: "set", key, value });
    flash();
  }

  function control(f) {
    const wrap = document.createElement("div");
    wrap.className = "control";
    const v = values[f.key];
    if (f.kind === "toggle") {
      const label = document.createElement("label"); label.className = "switch";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!v;
      input.addEventListener("change", () => save(f.key, input.checked));
      const track = document.createElement("span"); track.className = "track";
      const thumb = document.createElement("span"); thumb.className = "thumb";
      label.append(input, track, thumb); wrap.append(label);
    } else if (f.kind === "select") {
      const sel = document.createElement("select");
      const opts = f.optionsFromModelList ? (values["models.list"] || []) : (f.options || []);
      const list = opts.includes(v) || v === undefined ? opts : [v, ...opts];
      for (const o of list) { const opt = document.createElement("option"); opt.value = o; opt.textContent = o; sel.append(opt); }
      if (v !== undefined) sel.value = v;
      sel.addEventListener("change", () => save(f.key, sel.value));
      wrap.append(sel);
    } else if (f.kind === "text" || f.kind === "password" || f.kind === "number") {
      const input = document.createElement("input");
      input.type = f.kind === "number" ? "number" : f.kind;
      input.placeholder = f.placeholder || "";
      input.value = v === undefined || v === null ? "" : String(v);
      input.addEventListener("change", () => save(f.key, f.kind === "number" ? Number(input.value || 0) : input.value));
      wrap.append(input);
    } else if (f.kind === "stringlist") {
      wrap.classList.add("wide");
      const tags = document.createElement("div"); tags.className = "tags";
      const items = Array.isArray(v) ? [...v] : [];
      const renderTags = () => {
        tags.textContent = "";
        for (let i = 0; i < items.length; i++) {
          const tag = document.createElement("span"); tag.className = "tag";
          const text = document.createElement("span"); text.textContent = items[i];
          const del = document.createElement("button"); del.textContent = "×"; del.title = "Remove";
          del.addEventListener("click", () => { items.splice(i, 1); save(f.key, [...items]); renderTags(); });
          tag.append(text, del); tags.append(tag);
        }
        tags.append(input);
      };
      const input = document.createElement("input"); input.type = "text"; input.placeholder = "Type and press Enter…";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          items.push(input.value.trim()); input.value = "";
          save(f.key, [...items]); renderTags(); input.focus();
        }
      });
      renderTags();
      wrap.append(tags);
    } else if (f.kind === "json") {
      wrap.classList.add("wide");
      const holder = document.createElement("div"); holder.style.width = "100%";
      const ta = document.createElement("textarea");
      ta.value = v === undefined ? "" : JSON.stringify(v, null, 2);
      const status = document.createElement("div"); status.className = "json-status";
      ta.addEventListener("change", () => {
        try {
          const parsed = ta.value.trim() === "" ? (Array.isArray(v) ? [] : {}) : JSON.parse(ta.value);
          status.textContent = "Valid — saved"; status.className = "json-status ok";
          save(f.key, parsed);
        } catch (err) {
          status.textContent = "Invalid JSON: " + err.message; status.className = "json-status err";
        }
      });
      holder.append(ta, status); wrap.append(holder);
    }
    return wrap;
  }

  function renderAll() {
    const nav = document.getElementById("nav");
    const main = document.getElementById("main");
    const active = document.querySelector("nav button.active")?.dataset.id || SECTIONS[0].id;
    nav.textContent = ""; main.textContent = "";
    for (const s of SECTIONS) {
      const btn = document.createElement("button");
      btn.textContent = s.title; btn.dataset.id = s.id;
      if (s.id === active) btn.classList.add("active");
      btn.addEventListener("click", () => {
        document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll("main section").forEach((el) => el.classList.remove("active"));
        document.getElementById("sec-" + s.id).classList.add("active");
      });
      nav.append(btn);

      const sec = document.createElement("section");
      sec.id = "sec-" + s.id;
      if (s.id === active) sec.classList.add("active");
      const h = document.createElement("h2"); h.textContent = s.title;
      sec.append(h);
      for (const f of s.fields) {
        const row = document.createElement("div"); row.className = "row";
        if (f.kind === "json" || f.kind === "stringlist") row.classList.add("stacked");
        const meta = document.createElement("div"); meta.className = "meta";
        const label = document.createElement("div"); label.className = "label"; label.textContent = f.label;
        const desc = document.createElement("div"); desc.className = "desc"; desc.textContent = f.desc;
        meta.append(label, desc);
        row.append(meta, control(f));
        sec.append(row);
      }
      main.append(sec);
    }
  }

  document.getElementById("openRaw").addEventListener("click", () => vscodeApi.postMessage({ type: "openVSCodeSettings" }));
  window.addEventListener("message", (e) => {
    if (e.data.type === "config") { values = e.data.values; renderAll(); }
  });
  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
