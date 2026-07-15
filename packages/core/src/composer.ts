import type { ModelClient } from "./client.js";
import type { StreamEvent } from "./types.js";
import type { SemanticIndex } from "./rag/tool.js";

/**
 * Composer planning step (Phase 8). Before a multi-file task runs, the
 * model drafts an implementation plan — files to touch, order, and how to
 * verify — grounded in retrieved code context. The user approves, revises
 * with feedback, or discards; only an approved plan reaches the agent.
 */

const PLAN_SYSTEM_PROMPT = `You are Wright's planning module. Produce a concise implementation plan for the user's coding task — you are NOT executing anything yet.

Format (markdown):
## Plan: <short title>
**Goal** — one sentence.
**Steps** — numbered; each step names the file(s) it touches and what changes. Order matters: earlier steps must not depend on later ones.
**New files** — list with one-line purpose each (omit section if none).
**Verification** — the exact command(s) to run and what success looks like.
**Risks** — anything likely to break or need user input (omit if none).

Rules: stay under 350 words; no code blocks unless a snippet is essential to disambiguate; only reference files you have evidence exist (from the provided context) or explicitly mark as new.`;

export interface PlanRequest {
  task: string;
  /** Retrieved code context to ground the plan in reality. */
  context?: string;
  /** Prior plan + user feedback when revising. */
  priorPlan?: string;
  feedback?: string;
  /**
   * Recent conversation transcript so follow-up tasks ("continue", "now do X")
   * are grounded in what already happened — otherwise the planner sees only
   * the bare task text and reports "no prior context".
   */
  history?: string;
}

export function buildPlanMessages(req: PlanRequest): Array<{ role: "system" | "user"; content: string }> {
  let user = "";
  if (req.history) {
    user += `Conversation so far (context — the task below may continue this work):\n${req.history}\n\n`;
  }
  user += `Task:\n${req.task}`;
  if (req.context) user += `\n\nRelevant code context (retrieved automatically):\n${req.context}`;
  if (req.priorPlan && req.feedback) {
    user += `\n\nYou previously proposed this plan:\n${req.priorPlan}\n\nThe user wants it revised: ${req.feedback}\nProduce the full updated plan.`;
  }
  return [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export async function generatePlan(
  client: ModelClient,
  model: string,
  req: PlanRequest,
  opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void } = {},
): Promise<string> {
  const result = await client.streamToResult(
    { model, messages: buildPlanMessages(req), max_tokens: 2_048, temperature: 0.3 },
    opts,
  );
  return result.message.content ?? "";
}

/** Gather grounding context for the planner from the semantic index. */
export async function planContext(index: SemanticIndex, task: string, signal?: AbortSignal): Promise<string> {
  const vector = await index.embedQuery(task, signal);
  const hits = index.store.search(vector, 6);
  return hits
    .map((h) => `── ${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}\n${h.chunk.text.slice(0, 1_200)}`)
    .join("\n\n")
    .slice(0, 8_000);
}

/** The message handed to the agent once the user approves. */
export function executionMessage(task: string, plan: string): string {
  return `The user approved the following implementation plan. Execute it now, step by step, using your tools. After completing all steps, run the plan's verification and fix any failures before finishing.

Original task: ${task}

${plan}`;
}

/**
 * Extract actionable steps from a plan's markdown — numbered or bulleted list
 * items under (typically) a "Steps" heading. Falls back to all list items.
 */
export function parsePlanSteps(plan: string): string[] {
  const lines = plan.split("\n");
  const steps: string[] = [];
  let inSteps = false;
  for (const line of lines) {
    if (/^#{1,4}\s|^\*\*/.test(line.trim())) {
      inSteps = /steps/i.test(line);
    }
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*\S)/);
    if (m) steps.push(m[1]!.replace(/\*\*/g, "").trim());
    else void inSteps;
  }
  // De-dupe and cap; if we somehow got nothing, return empty (caller keeps prose).
  return [...new Set(steps)].slice(0, 40);
}

/** Build an execution message from a user-edited checklist of steps. */
export function executionMessageFromSteps(task: string, steps: string[]): string {
  const list = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `The user reviewed and approved this implementation checklist. Execute each step in order using your tools, then verify (build/tests) and fix any failures before finishing. Do only what these steps describe.

Original task: ${task}

Steps:
${list}`;
}
