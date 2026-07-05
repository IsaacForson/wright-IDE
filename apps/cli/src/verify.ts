/**
 * Phase 0.2 verification: prove the NVIDIA plumbing works before building
 * anything on top of it. Four checks, in order of increasing importance:
 *
 *   1. /models responds (auth + connectivity)
 *   2. Basic chat completion
 *   3. Streaming (stream: true, tokens arrive incrementally)
 *   4. Tool calling — the model emits tool_calls, and accepts the tool
 *      result fed back. If this fails on your chosen model, pick another
 *      model NOW; the whole agent depends on it.
 *
 * Usage: pnpm verify            (uses NVIDIA_MODEL from .env)
 *        pnpm verify -- <model> (test a specific model id)
 */

import {
  ModelClient,
  ModelError,
  nvidiaProvider,
  type ChatMessage,
  type ToolDefinition,
} from "@wright/core";
import { requireEnv } from "./env.js";

const env = requireEnv();
const model = process.argv[2] ?? env.model;
const client = new ModelClient(
  nvidiaProvider({ apiKey: env.apiKey, chatModel: model, fastModel: env.fastModel }),
);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  process.stdout.write(`${name} ... `);
  const start = Date.now();
  try {
    const detail = await fn();
    console.log(`${green("PASS")} ${dim(`(${Date.now() - start}ms)`)} ${detail}`);
  } catch (err) {
    failures++;
    const msg = err instanceof ModelError ? `[${err.kind}] ${err.message}` : String(err);
    console.log(`${red("FAIL")} ${msg}`);
  }
}

console.log(`Verifying NVIDIA NIM plumbing with model: ${model}\n`);

await check("1. List models", async () => {
  const models = await client.listModels();
  if (models.length === 0) throw new Error("empty model list");
  const hasOurs = models.includes(model);
  return `${models.length} models available${hasOurs ? "" : red(` — WARNING: "${model}" not in list`)}`;
});

await check("2. Chat completion", async () => {
  const result = await client.complete({
    model,
    messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
    max_tokens: 512,
    temperature: 0,
  });
  const text = result.message.content?.trim() ?? "";
  if (!text) throw new Error("empty response");
  return dim(`"${text.slice(0, 60)}"`);
});

await check("3. Streaming", async () => {
  let chunks = 0;
  let text = "";
  const result = await client.streamToResult(
    { model, messages: [{ role: "user", content: "Count from 1 to 5, digits only." }], max_tokens: 512 },
    {
      onEvent: (e) => {
        if (e.type === "text") {
          chunks++;
          text += e.text;
        }
      },
    },
  );
  if (!text && !result.message.content) throw new Error("no streamed text");
  if (chunks < 2) throw new Error(`only ${chunks} chunk(s) — streaming may not be working`);
  return dim(`${chunks} chunks: "${text.trim().slice(0, 40)}"`);
});

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

await check("4. Tool calling (round trip)", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "What is the weather in Accra right now? Use the tool." },
  ];
  const first = await client.complete({
    model,
    messages,
    tools: [weatherTool],
    max_tokens: 1024,
    temperature: 0,
  });

  const call = first.message.tool_calls?.[0];
  if (!call) {
    throw new Error(
      `model returned no tool_calls (got text: "${first.message.content?.slice(0, 80)}"). ` +
        "This model may not support tools — pick a different one.",
    );
  }
  const args = JSON.parse(call.function.arguments) as { city?: string };
  if (!args.city) throw new Error(`tool args missing city: ${call.function.arguments}`);

  // Feed the tool result back — the full round trip the agent loop depends on.
  messages.push(first.message);
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ city: args.city, temp_c: 29, condition: "partly cloudy" }),
  });
  const second = await client.complete({ model, messages, tools: [weatherTool], max_tokens: 512 });
  const answer = second.message.content ?? "";
  if (!/29|cloud/i.test(answer)) {
    throw new Error(`model ignored the tool result: "${answer.slice(0, 80)}"`);
  }
  return dim(`called ${call.function.name}(${call.function.arguments.trim()}) → used result in answer`);
});

console.log();
if (failures === 0) {
  console.log(green(`All checks passed. "${model}" is agent-ready.`));
} else {
  console.log(red(`${failures} check(s) failed.`));
  console.log("If tool calling failed, try another model: pnpm verify -- <model-id>");
  process.exit(1);
}
