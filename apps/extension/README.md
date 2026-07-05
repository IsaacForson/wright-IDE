# Wright

A Cursor-like AI coding agent for VS Code, powered by [NVIDIA NIM](https://build.nvidia.com).

## Features

- **Agent chat** — a tool-using agent (read, edit, write, search, run commands, semantic codebase search, web search) that investigates, acts, and verifies in a loop, streaming its work as an activity log.
- **Composer** — check *Plan* to get an approvable implementation plan before any code is touched; revise it with feedback, then execute.
- **Reviewable diffs** — every edit is snapshotted; the Changes panel shows per-file diffs with Keep / Revert (and Revert all).
- **Inline edit (Cmd+K)** — select code, describe a change (`Ctrl+Cmd+K` / `Ctrl+Alt+K`), get it rewritten in place.
- **Codebase understanding** — semantic index over your repo so the agent finds relevant code you never mentioned; `@file` mentions attach exact files.
- **Vision** — attach or paste an image (📎 or paste) to send a screenshot/mockup to a multimodal model.
- **Local tab autocomplete** — ghost-text completions via a local Ollama FIM model (never uses cloud quota).
- **Safety** — manual / auto-edit / auto approval modes, a command allow/deny list, protected-path guards for credentials, and a live token/cost meter.
- **Extras** — MCP tool servers, and AI-generated git commit messages (✨ in Source Control).

## Setup

1. Get an API key at [build.nvidia.com](https://build.nvidia.com).
2. Set it in **Settings → Wright: Nvidia › Api Key** (`wright.nvidia.apiKey`), or put `NVIDIA_API_KEY=…` in a `.env` at your workspace root.
3. Open the **Wright** view from the activity bar and start chatting.

## Key settings

| Setting | What |
|---|---|
| `wright.model.chat` | Primary agent model (must support tool calling). Default `z-ai/glm-5.2`. |
| `wright.model.fast` | Fast model for inline edit & commit messages. |
| `wright.model.vision` | Multimodal model used when a message includes an image. |
| `wright.approvalMode` | `manual` · `auto-edit` · `auto`. |
| `wright.webSearch.provider` / `apiKey` | `duckduckgo` (keyless) · `tavily` · `brave`. |
| `wright.autocomplete.*` | Local Ollama FIM completions. |
| `wright.mcp.servers` | MCP tool servers to expose to the agent. |

## Commands

- **Wright: New Chat**
- **Wright: Inline Edit** (`Ctrl+Cmd+K` / `Ctrl+Alt+K`)
- **Wright: Generate Commit Message**
- **Wright: Rebuild Codebase Index**
