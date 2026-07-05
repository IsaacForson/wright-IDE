/**
 * Phase 3 deliverable: the agent loop in a terminal.
 *
 * Usage:
 *   pnpm agent -- --root <dir> "task"          one-shot task
 *   pnpm agent -- --root <dir> -y "task"       auto-approve run_command (careful)
 *   pnpm agent -- --root <dir>                 interactive REPL
 *
 * Defaults: --root defaults to the directory pnpm was invoked from.
 */

import * as readline from "node:readline/promises";
import {
  Agent,
  ModelClient,
  ModelError,
  TrackedHost,
  agentSystemPrompt,
  createBuiltinTools,
  createCodebaseSearchTool,
  nvidiaProvider,
} from "@wright/core";
import { Indexer, NodeWorkspaceHost } from "@wright/core/node";
import { requireEnv } from "./env.js";
import * as path from "node:path";

const argv = process.argv.slice(2);
const autoApprove = argv.includes("-y");
const rootIdx = argv.indexOf("--root");
const root = path.resolve(rootIdx !== -1 ? argv[rootIdx + 1]! : process.env.INIT_CWD ?? process.cwd());
const positional = argv.filter((a, i) => a !== "-y" && a !== "--root" && i !== rootIdx + 1);
const oneShot = positional[0];

const env = requireEnv();
const client = new ModelClient(nvidiaProvider({ apiKey: env.apiKey, chatModel: env.model }));
const host = new TrackedHost(new NodeWorkspaceHost(root));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Semantic search joins the tool set when this workspace has an index
// (build one with: pnpm index -- --root <dir>).
const embedModel = process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nv-embedcode-7b-v1";
const indexer = await Indexer.load(client, embedModel, root);
const tools = createBuiltinTools(host);
if (indexer.isBuilt) tools.push(createCodebaseSearchTool(indexer));

const agent = new Agent({
  client,
  model: env.model,
  tools,
  systemPrompt: agentSystemPrompt({ workspaceName: path.basename(root) }),
  approve: async (name, args) => {
    if (autoApprove) return true;
    const answer = await rl.question(yellow(`\napprove ${name}(${JSON.stringify(args)})? [y/N] `));
    return answer.trim().toLowerCase() === "y";
  },
});

console.log(`Wright agent — model: ${env.model} — workspace: ${root}`);
console.log(
  indexer.isBuilt
    ? `codebase index: ${indexer.store.fileCount} files / ${indexer.store.chunkCount} chunks (semantic search ON)`
    : "codebase index: none (run `pnpm index -- --root <dir>` to enable semantic search)",
);
if (autoApprove) console.log(yellow("auto-approve is ON: shell commands run without confirmation"));
console.log();

async function runTurn(task: string): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let streamingText = false;
  try {
    for await (const event of agent.run(task, { signal: controller.signal })) {
      switch (event.type) {
        case "text":
          streamingText = true;
          process.stdout.write(event.text);
          break;
        case "tool_start": {
          if (streamingText) process.stdout.write("\n");
          streamingText = false;
          const argsPreview = JSON.stringify(event.args);
          process.stdout.write(cyan(`⚒ ${event.name} `) + dim(argsPreview.length > 120 ? argsPreview.slice(0, 120) + "…" : argsPreview) + "\n");
          break;
        }
        case "tool_done": {
          const first = event.result.output.split("\n")[0] ?? "";
          const mark = event.result.ok ? dim("  ✓ ") : red("  ✗ ");
          process.stdout.write(mark + dim(first.slice(0, 160)) + "\n");
          break;
        }
        case "done":
          process.stdout.write(
            `\n${dim(`[${event.iterations} iteration(s) · ${event.usage.prompt_tokens}→${event.usage.completion_tokens} tokens]`)}\n`,
          );
          break;
      }
    }
  } catch (err) {
    if (err instanceof ModelError && err.kind === "aborted") {
      process.stdout.write(dim("\n[cancelled]\n"));
    } else {
      const msg = err instanceof ModelError ? `[${err.kind}] ${err.message}` : String(err);
      process.stdout.write(`\n${red(`error: ${msg}`)}\n`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  printChanges();
}

function printChanges(): void {
  const changes = host.changes();
  if (changes.length === 0) return;
  console.log(dim("\nchanged files (revertible with /revert <path>, /revert all):"));
  for (const c of changes) {
    const mark = c.kind === "created" ? "A" : "M";
    console.log(`  ${yellow(mark)} ${c.path}`);
  }
}

async function handleSlashCommand(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/changes":
      printChanges();
      if (host.changes().length === 0) console.log(dim("no pending changes"));
      return true;
    case "/revert":
      if (arg === "all") {
        await host.revertAll();
        console.log(dim("reverted all changes"));
      } else if (arg) {
        await host.revert(arg);
        console.log(dim(`reverted ${arg}`));
      } else {
        console.log(dim("usage: /revert <path> | /revert all"));
      }
      return true;
    case "/keep":
      if (arg === "all" || !arg) host.keepAll();
      else host.keep(arg);
      console.log(dim("kept"));
      return true;
    default:
      return false;
  }
}

if (oneShot) {
  await runTurn(oneShot);
  rl.close();
} else {
  while (true) {
    let input: string;
    try {
      input = (await rl.question(cyan("\ntask > "))).trim();
    } catch {
      break;
    }
    if (!input || input === "/exit") break;
    if (input.startsWith("/")) {
      if (await handleSlashCommand(input)) continue;
    }
    await runTurn(input);
  }
  rl.close();
  console.log(dim("bye"));
}
