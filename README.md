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
- [ ] **Phase 6+** — inline edit, composer, safety, persistence…
