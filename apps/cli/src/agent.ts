/**
 * The agent loop in a terminal.
 *
 * Usage:
 *   pnpm agent -- --root <dir> "task"          one-shot task
 *   pnpm agent -- --root <dir> --plan "task"   composer mode: plan → approve → execute
 *   pnpm agent -- --root <dir> -y "task"       auto-approve run_command (careful)
 *   pnpm agent -- --root <dir>                 interactive REPL (/plan <task> works too)
 *
 * Defaults: --root defaults to the directory pnpm was invoked from.
 */

import * as readline from "node:readline/promises";
import {
  Agent,
  ApprovalPolicy,
  ModelClient,
  ModelError,
  TrackedHost,
  type ApprovalMode,
  agentSystemPrompt,
  createBuiltinTools,
  createCodebaseSearchTool,
  createWebSearchTool,
  executionMessage,
  generatePlan,
  nvidiaProvider,
  planContext,
} from "@wright/core";
import { Indexer, NodeWorkspaceHost, connectMcpServers, loadRulesFile, type McpServerConfig } from "@wright/core/node";
import { requireEnv } from "./env.js";
import * as path from "node:path";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const autoApprove = argv.includes("-y");
const planFirst = argv.includes("--plan");
const rootIdx = argv.indexOf("--root");
const modeIdx = argv.indexOf("--mode");
const root = path.resolve(rootIdx !== -1 ? argv[rootIdx + 1]! : process.env.INIT_CWD ?? process.cwd());
const mode: ApprovalMode = autoApprove
  ? "auto"
  : modeIdx !== -1 && ["manual", "auto-edit", "auto"].includes(argv[modeIdx + 1]!)
    ? (argv[modeIdx + 1] as ApprovalMode)
    : "auto-edit";
const positional = argv.filter(
  (a, i) => a !== "-y" && a !== "--plan" && a !== "--root" && a !== "--mode" && i !== rootIdx + 1 && i !== modeIdx + 1,
);
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
tools.push(
  createWebSearchTool({
    provider: (process.env.WRIGHT_SEARCH_PROVIDER as "tavily" | "brave" | "duckduckgo") || undefined,
    apiKey: process.env.WRIGHT_SEARCH_API_KEY,
  }),
);

// MCP servers from <workspace>/.wright/mcp.json: {"servers": {name: {command, args?, env?}}}
let mcpToolCount = 0;
let mcpDispose: (() => Promise<void>) | undefined;
try {
  const mcpConfig = JSON.parse(readFileSync(path.join(root, ".wright", "mcp.json"), "utf8")) as {
    servers?: Record<string, McpServerConfig>;
  };
  if (mcpConfig.servers && Object.keys(mcpConfig.servers).length > 0) {
    const conn = await connectMcpServers(mcpConfig.servers, {
      onError: (server, err) => console.error(`mcp server "${server}" failed: ${String(err).slice(0, 120)}`),
    });
    tools.push(...conn.tools);
    mcpToolCount = conn.tools.length;
    mcpDispose = conn.dispose;
  }
} catch {
  // no mcp.json — fine
}

/** MCP stdio children keep the event loop alive — always tear down on exit. */
async function shutdown(): Promise<never> {
  await mcpDispose?.().catch(() => {});
  process.exit(0);
}

const policy = new ApprovalPolicy({ mode });
const rules = await loadRulesFile(root);

const agent = new Agent({
  client,
  model: env.model,
  tools,
  systemPrompt: agentSystemPrompt({ workspaceName: path.basename(root), rules }),
  approve: async (name, args) => {
    const decision = policy.decide(name, args);
    if (decision.action === "allow") return true;
    const detail = name === "run_command" ? String(args.command ?? "") : JSON.stringify(args).slice(0, 160);
    const why = decision.reason ? dim(` (${decision.reason})`) : "";
    try {
      const answer = await rl.question(yellow(`\napprove ${name}: ${detail}${why} ? [y/N] `));
      return answer.trim().toLowerCase() === "y";
    } catch {
      return false; // stdin closed → decline
    }
  },
});

console.log(`Wright agent — model: ${env.model} — mode: ${mode} — workspace: ${root}`);
if (rules) console.log(dim("project rules file loaded"));
if (mcpToolCount > 0) console.log(dim(`${mcpToolCount} MCP tool(s) connected`));
console.log(
  indexer.isBuilt
    ? `codebase index: ${indexer.store.fileCount} files / ${indexer.store.chunkCount} chunks (semantic search ON)`
    : "codebase index: none (run `pnpm index -- --root <dir>` to enable semantic search)",
);
if (mode === "auto") console.log(yellow("auto mode: only deny-listed commands and protected paths will ask"));
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

/** Composer flow: draft a plan, let the user approve/revise/quit, then execute. */
async function runComposer(task: string): Promise<void> {
  let priorPlan: string | undefined;
  let feedback: string | undefined;
  while (true) {
    console.log(dim("\n─ drafting plan ─\n"));
    const context = indexer.isBuilt ? await planContext(indexer, task) : undefined;
    let plan: string;
    try {
      plan = await generatePlan(client, env.model, { task, context, priorPlan, feedback }, {
        onEvent: (e) => {
          if (e.type === "text") process.stdout.write(e.text);
        },
      });
    } catch (err) {
      console.log(red(`\nplan failed: ${err instanceof ModelError ? err.message : String(err)}`));
      return;
    }
    let answer: string;
    try {
      answer = (await rl.question(yellow("\n\n[e]xecute · [r]evise · [q]uit > "))).trim().toLowerCase();
    } catch {
      console.log(dim("\nstdin closed — plan discarded"));
      return;
    }
    if (answer === "e") {
      await runTurn(executionMessage(task, plan));
      return;
    }
    if (answer === "r") {
      priorPlan = plan;
      feedback = (await rl.question(cyan("what should change? > "))).trim();
      continue;
    }
    console.log(dim("plan discarded"));
    return;
  }
}

if (oneShot) {
  if (planFirst) await runComposer(oneShot);
  else await runTurn(oneShot);
  rl.close();
  await shutdown();
} else {
  while (true) {
    let input: string;
    try {
      input = (await rl.question(cyan("\ntask > "))).trim();
    } catch {
      break;
    }
    if (!input || input === "/exit") break;
    if (input.startsWith("/plan ")) {
      await runComposer(input.slice(6).trim());
      continue;
    }
    if (input.startsWith("/")) {
      if (await handleSlashCommand(input)) continue;
    }
    await runTurn(input);
  }
  rl.close();
  console.log(dim("bye"));
  await shutdown();
}
