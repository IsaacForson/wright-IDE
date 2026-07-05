# Wright

A Cursor-like AI IDE, built as a VS Code extension, powered by NVIDIA NIM.

> The model is not the product — the harness is.

## Layout

| Package | What | Rule |
|---|---|---|
| [`packages/core`](packages/core) | Model client, provider abstraction, token budgeting; later: tools, agent loop, diff applier, indexing | **Zero VS Code imports.** Framework-agnostic TypeScript, testable in isolation. |
| [`apps/cli`](apps/cli) | Test harness for core — verification script + streaming chat REPL | |
| [`apps/extension`](apps/extension) | VS Code extension: chat webview (React, in `webview/`), workspace access layer, config | Bundled with esbuild; `src/` is host-side, `webview/` is browser-side, [protocol.ts](apps/extension/src/protocol.ts) is the contract between them. |

## Setup

```sh
pnpm install
cp .env.example .env   # paste your key from https://build.nvidia.com
pnpm verify            # proves chat + streaming + tool calling work
pnpm chat              # interactive streaming chat
```

`pnpm verify` runs the four Phase 0.2 checks. **Check 4 (tool calling) is the
one that matters** — if your chosen model fails it, the agent loop (Phase 3)
cannot work. Test alternatives with `pnpm verify -- <model-id>`; check 1
prints how many models the catalog exposes.

## Phase status

- [x] **Phase 0** — decisions locked (VS Code extension shell, NVIDIA NIM, monorepo); live-verified: model `z-ai/glm-5.2` passes chat + streaming + tool round trip
- [x] **Phase 1** — model connectivity: streaming SSE client, tool calling, typed errors, retry/backoff, cancellation, token budgeting
- [x] **Phase 2** — VS Code extension with streaming React chat webview + workspace access APIs. Run it: open this repo in VS Code, press **F5**, then click the Wright icon in the activity bar.
- [x] **Phase 3** — tools & the agent loop: six composable tools (`read_file`, `edit_file`, `write_file`, `list_dir`, `search`, `run_command`), ReAct loop with a 25-iteration cap, approval gate on shell commands, cancellation, search/replace edit application with whitespace-tolerant fallback. Try it in the terminal: `pnpm agent -- --root <dir> "task"` (add `-y` to auto-approve commands); the extension chat is now the same agent with a tool activity log.
- [x] **Phase 4** — diff generation & application: search/replace applier (exact → whitespace-tolerant fallback, corrective errors fed back to the model) plus change tracking. Every agent edit is snapshotted before the first write; the extension shows a **Changes** panel (click a file → native VS Code diff of original vs current; Keep/Revert per file or all), and the CLI prints changed files with `/changes`, `/revert <path|all>`, `/keep`. Edits apply to disk immediately — deliberately, so the agent's own build/test verification sees them — but nothing is final until you keep it.
- [x] **Phase 5** — codebase indexing (RAG): heuristic code-aware chunking, embeddings via `nvidia/nv-embedcode-7b-v1`, local vector index at `~/.wright/index/` (brute-force cosine — no native deps), incremental re-embed by file hash. The agent gets a `codebase_search` tool (semantic, by meaning) composing with `search` (lexical, exact) for hybrid retrieval. Build the index with `pnpm index -- --root <dir>`; the extension builds it in the background, re-indexes on save, and has a **Wright: Rebuild Codebase Index** command. `@path/to/file` mentions in chat attach exact files.
- [x] **Phase 8** — composer (plan → approve → execute): check **Plan** in the chat panel (or `pnpm agent -- --plan "task"` / `/plan <task>` in the REPL) and Wright drafts an implementation plan — goal, ordered steps with files, verification commands, risks — grounded in semantic retrieval from the index. You approve, revise with plain-text feedback, or discard; only approved plans reach the agent, which executes step-by-step and runs the plan's verification. Multi-file changesets and one-click rollback come from Phase 4's Changes panel.
- [x] **Phase 9** — safety & control: approval modes (**manual** / **auto-edit** / **auto**, switchable in the chat panel or `wright.approvalMode`), command allowlist (tests/builds run silently) and denylist (`rm -rf`, `git push`, `sudo`, pipe-to-shell always ask), protected paths (`.env`, keys, credentials — guarded against both direct writes **and** shell-command side doors like `> .env`), and a session token/cost meter (`wright.pricing.*` to add $ estimates).
- [x] **Phase 10** — persistence & config: chat sessions survive VS Code restarts (per-workspace), a `.wrightrules` file (or existing `.cursorrules`) is always folded into the system prompt, and model routing sends inline edits to the fast model while the agent uses the strong one.
- [x] **Phase 6** — inline edit: select code, hit **Ctrl+Cmd+K** (Ctrl+Alt+K on Win/Linux), describe the change; the fast model rewrites it in place (~2s). No selection = generate at cursor. Undo rejects, save accepts.
- [x] **Phase 7** — tab autocomplete: ghost-text completions via a **local Ollama FIM model** (default `qwen-coder-7b`, ~800ms warm), never NVIDIA — autocomplete is the highest-volume caller and would burn quota. 250ms debounce, hard cancellation on every keystroke, completion cache, suffix-overlap trimming. Silently inactive when Ollama isn't running; configure under `wright.autocomplete.*`. (NVIDIA's gateway is chat-only — no `/v1/completions`, so no cloud FIM.)
- [x] **Phase 11 (MCP + git)** — MCP support: configure servers in `wright.mcp.servers` (extension) or `.wright/mcp.json` (CLI) and their tools join the agent's tool set as `mcp_<server>_<tool>`; they require approval except in auto mode. Git integration: **Wright: Generate Commit Message** (✨ button in the Source Control panel) writes a conventional-commit message from the staged diff into the commit box using the fast model.
- [x] **Phase 11 (web search)** — a `web_search` tool the agent composes with codebase search. Pluggable backend: keyless **DuckDuckGo** instant-answer by default (covers well-known topics), or full web search via **Tavily**/**Brave** with an API key (`wright.webSearch.*` / `WRIGHT_SEARCH_API_KEY`).
- [x] **Phase 11 (vision)** — attach or paste an image into the chat (📎 or Ctrl/Cmd+V); Wright auto-routes that turn to a multimodal model (`meta/llama-4-maverick`) so you can screenshot a mockup and ask for the UI. (NVIDIA's gateway won't *stream* image responses, so vision turns run non-streamed automatically.)
- [ ] **Phase 11 leftovers** — multi-agent orchestration, the Jarvis voice bridge, local-first chat fallback
