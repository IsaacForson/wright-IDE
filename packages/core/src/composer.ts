import type { ModelClient } from "./client.js";
import type { StreamEvent } from "./types.js";
import type { SemanticIndex } from "./rag/tool.js";
import type { AskUserQuestion } from "./askUser.js";

/**
 * Composer planning step (Phase 8). Before a multi-file task runs, the
 * model drafts an implementation plan — files to touch, order, and how to
 * verify — grounded in retrieved code context. The user approves, revises
 * with feedback, or discards; only an approved plan reaches the agent.
 */

const PLAN_SYSTEM_PROMPT = `You are Wright's planning module. Produce an implementation plan for the user's coding task, written like a real engineering hand-off ticket — you are NOT executing anything yet.

Format (markdown, use these EXACT section headings):
## Plan: <short title>

## Overview
2-4 sentences: what we're building, for whom, and the shape of the solution.

## Architecture
An ASCII diagram in a fenced code block (\\\`\\\`\\\` ... \\\`\\\`\\\`) showing the components and how data flows between them (boxes + arrows, max ~20 lines). Below it, 1-2 sentences explaining the diagram.

## Tradeoffs
2-4 bullet points: key decisions made, what was chosen over what alternative, and why (e.g. "SQLite over Postgres — zero setup for local dev; swap the Prisma datasource later if deploying").

## Steps
Numbered; each step names the file(s) it touches and what changes. Order matters: earlier steps must not depend on later ones. Steps must ONLY appear in this section.

## Verification
The exact command(s) to run and what success looks like.

## Risks
Anything likely to break or need user input (omit this section if none).

Rules: stay under 550 words total; the Architecture code block is the only code block; only reference files you have evidence exist (from the provided context) or explicitly mark as new.`;

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
  /** The user's answers to clarifying questions, folded into the plan brief. */
  answers?: string;
}

export function buildPlanMessages(req: PlanRequest): Array<{ role: "system" | "user"; content: string }> {
  let user = "";
  if (req.history) {
    user += `Conversation so far (context — the task below may continue this work):\n${req.history}\n\n`;
  }
  user += `Task:\n${req.task}`;
  if (req.answers) user += `\n\nThe user answered these clarifying questions — honor them exactly:\n${req.answers}`;
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

const PLAN_CLARIFY_PROMPT = `You are Wright's planning module, deciding whether to ask the user clarifying questions BEFORE drafting an implementation plan. A plan that guesses the wrong platform or stack is worse than a short question.

Ask ONLY when a choice would MATERIALLY change the plan and you cannot safely infer it from the task or existing code: target platform (web / iOS / Android / cross-platform / desktop), core language/framework, backend or database choice, auth approach, or MVP scope. Do NOT ask about trivial details, naming, or things the task already answers.

Respond with ONLY a JSON object (no prose, no code fence):
{"questions":[{"id":"platform","prompt":"Which platform(s) should this target?","allow_multiple":false,"options":[{"id":"web","label":"Web (React)","recommended":true},{"id":"cross","label":"Cross-platform (React Native)"},{"id":"ios","label":"iOS (Swift)"}]}]}

Rules: at most 3 questions; each has 3-6 options; mark exactly one recommended per question. Each option must be ONE specific, mutually-exclusive choice — NEVER bundle alternatives into a single option. For "which cross-platform framework", list "Flutter", "React Native", "Ionic", "Expo" as SEPARATE options; do NOT write "Flutter/React Native" as one option (the user can only build with one). The user can also type their own answer, so offer the real distinct contenders. If the task is already specific enough to plan without guessing, respond with {"questions":[]}.`;

/**
 * Decide whether the plan needs clarification first. Returns the questions to
 * ask (in the ask_user shape) or [] when the task is clear enough to plan.
 * Tolerant of models that wrap the JSON in prose or a code fence.
 */
export async function clarifyPlan(
  client: ModelClient,
  model: string,
  req: PlanRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<AskUserQuestion[]> {
  const user =
    `Task:\n${req.task}` +
    (req.history ? `\n\nConversation so far:\n${req.history}` : "") +
    (req.context ? `\n\nRelevant existing code:\n${req.context}` : "");
  let text: string;
  try {
    const result = await client.complete(
      {
        model,
        messages: [
          { role: "system", content: PLAN_CLARIFY_PROMPT },
          { role: "user", content: user },
        ],
        max_tokens: 700,
        temperature: 0.2,
      },
      { signal: opts.signal },
    );
    text = result.message.content ?? "";
  } catch {
    return []; // never block planning on a clarify failure
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const raw = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const questions: AskUserQuestion[] = [];
  for (const q of raw.slice(0, 3)) {
    if (!q || typeof q !== "object") continue;
    const { id, prompt, options, allow_multiple } = q as Record<string, unknown>;
    if (typeof prompt !== "string" || !Array.isArray(options)) continue;
    const opts2 = options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string")
      .slice(0, 6)
      .map((o, i) => ({
        id: typeof o.id === "string" ? o.id : `o${i}`,
        label: String(o.label),
        description: typeof o.description === "string" ? o.description : undefined,
        recommended: o.recommended === true,
      }));
    if (opts2.length < 2) continue;
    questions.push({
      id: typeof id === "string" ? id : `q${questions.length}`,
      prompt,
      options: opts2,
      allow_multiple: allow_multiple === true,
    });
  }
  return questions;
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
  const collect = (onlyStepsSection: boolean): string[] => {
    const steps: string[] = [];
    let inSteps = !onlyStepsSection;
    let inFence = false;
    for (const line of plan.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue; // diagram lines are not steps
      if (/^#{1,4}\s|^\*\*/.test(trimmed)) {
        inSteps = onlyStepsSection ? /steps/i.test(trimmed) : true;
        continue;
      }
      if (!inSteps) continue;
      const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*\S)/);
      if (m) steps.push(m[1]!.replace(/\*\*/g, "").trim());
    }
    return steps;
  };
  // Prefer bullets inside the Steps section (keeps Tradeoffs/Overview bullets
  // out of the checklist); fall back to all bullets for free-form plans.
  const scoped = collect(true);
  const steps = scoped.length > 0 ? scoped : collect(false);
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
