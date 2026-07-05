/**
 * Phase 1 deliverable: interactive streaming chat against NVIDIA NIM.
 * Type a prompt, watch tokens stream back. Ctrl+C once to cancel a
 * response in flight, /exit to quit.
 */

import * as readline from "node:readline/promises";
import {
  ContextBudget,
  ModelClient,
  ModelError,
  estimateConversationTokens,
  nvidiaProvider,
  type ChatMessage,
} from "@wright/core";
import { requireEnv } from "./env.js";

const env = requireEnv();
const client = new ModelClient(
  nvidiaProvider({ apiKey: env.apiKey, chatModel: env.model, fastModel: env.fastModel }),
);
const budget = new ContextBudget({ contextWindow: 64_000, outputReserve: 4_096 });

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let messages: ChatMessage[] = [
  { role: "system", content: "You are a concise, helpful coding assistant." },
];

console.log(`Wright chat — model: ${env.model}`);
console.log(dim("Commands: /exit quit · /clear reset history · Ctrl+C cancels a streaming reply\n"));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  let input: string;
  try {
    input = (await rl.question(cyan("you > "))).trim();
  } catch {
    break; // Ctrl+C / Ctrl+D at the prompt
  }
  if (!input) continue;
  if (input === "/exit") break;
  if (input === "/clear") {
    messages = messages.slice(0, 1);
    console.log(dim("history cleared\n"));
    continue;
  }

  messages.push({ role: "user", content: input });
  messages = budget.trimToFit(messages);

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  process.stdout.write("\nwright > ");
  const start = Date.now();
  try {
    const result = await client.streamToResult(
      { model: env.model, messages, max_tokens: 4_096 },
      {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "text") process.stdout.write(e.text);
        },
      },
    );
    messages.push(result.message);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    const tokens = result.usage
      ? `${result.usage.prompt_tokens}→${result.usage.completion_tokens} tokens`
      : `~${estimateConversationTokens(messages)} tokens in history`;
    process.stdout.write(`\n${dim(`[${secs}s · ${tokens}]`)}\n\n`);
  } catch (err) {
    if (err instanceof ModelError && err.kind === "aborted") {
      // Drop the cancelled user turn so history stays consistent.
      messages.pop();
      process.stdout.write(dim("\n[cancelled]\n\n"));
    } else {
      messages.pop();
      const msg = err instanceof ModelError ? `[${err.kind}] ${err.message}` : String(err);
      process.stdout.write(`\n\x1b[31merror: ${msg}\x1b[0m\n\n`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

rl.close();
console.log(dim("bye"));
