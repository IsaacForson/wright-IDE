import type { Tool } from "./tools.js";

/**
 * Structured clarifying questions (Cursor-style AskQuestion).
 * The model signals questions by calling this tool — the host parks until
 * the user submits picks in the chat UI. Topics stay out of the option list.
 */

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserQuestion {
  id: string;
  /** The topic / question text — never an answer choice. */
  prompt: string;
  options: AskUserOption[];
  allow_multiple?: boolean;
}

export interface AskUserPayload {
  questions: AskUserQuestion[];
}

export type AskUserWaiter = (payload: AskUserPayload, signal?: AbortSignal) => Promise<string>;

export function createAskUserTool(waitForAnswers: AskUserWaiter): Tool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "SIGNAL for selectable clarifying questions in the chat UI. " +
          "Call this whenever you need the user to choose before you can proceed " +
          "(platform, framework, scope, auth, etc.). " +
          "This is the ONLY way to show clickable answer chips — never write those " +
          "choices as a markdown questionnaire. " +
          "Do NOT use after a finished answer, for polite 'anything else?', or to re-list facts. " +
          "Each question: `prompt` = topic; `options` = concrete answers only (never the topic). " +
          "Each option must be ONE specific, mutually-exclusive choice — NEVER bundle alternatives " +
          "(do NOT write 'Flutter/React Native' as one option; list 'Flutter', 'React Native', 'Ionic' " +
          "as separate options). The user can also type a custom answer, so offer the real distinct contenders. " +
          "At most 3 questions. One JSON object. Then STOP and wait for the tool result.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable id for this question (e.g. framework)" },
                  prompt: {
                    type: "string",
                    description: "The question/topic shown as a header (e.g. \"Which mobile framework?\")",
                  },
                  allow_multiple: {
                    type: "boolean",
                    description: "If true, user may pick more than one option",
                  },
                  options: {
                    type: "array",
                    minItems: 2,
                    maxItems: 20,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        label: { type: "string", description: "Short answer label shown on the button" },
                        description: { type: "string", description: "Optional one-line detail" },
                        recommended: { type: "boolean" },
                      },
                      required: ["id", "label"],
                    },
                  },
                },
                required: ["id", "prompt", "options"],
              },
            },
          },
          required: ["questions"],
        },
      },
    },
    async execute(args, signal) {
      const parsed = normalizeAskUserArgs(args);
      if (!parsed.ok) return { ok: false, output: parsed.error };
      try {
        const answer = await waitForAnswers({ questions: parsed.questions }, signal);
        return { ok: true, output: answer };
      } catch (err) {
        return {
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function normalizeAskUserArgs(
  args: Record<string, unknown>,
): { ok: true; questions: AskUserQuestion[] } | { ok: false; error: string } {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "ask_user requires a non-empty questions array." };
  }
  const questions: AskUserQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const rec = q as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : `q${questions.length + 1}`;
    const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
    const optsRaw = Array.isArray(rec.options) ? rec.options : [];
    const options: AskUserOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const opt = o as Record<string, unknown>;
      const oid = typeof opt.id === "string" ? opt.id : `o${options.length + 1}`;
      const label = typeof opt.label === "string" ? opt.label.trim() : "";
      if (!label) continue;
      if (prompt && label.toLowerCase().replace(/:$/, "") === prompt.toLowerCase().replace(/[?:]$/, "")) {
        continue;
      }
      options.push({
        id: oid,
        label,
        description: typeof opt.description === "string" ? opt.description : undefined,
        recommended: opt.recommended === true,
      });
    }
    if (prompt && options.length >= 2) {
      questions.push({
        id,
        prompt,
        options,
        allow_multiple: rec.allow_multiple === true,
      });
    }
  }
  if (questions.length === 0) {
    return {
      ok: false,
      error:
        "ask_user needs each question to have a prompt (topic) and at least 2 answer options. " +
        "Do not put topics in the options list.",
    };
  }
  return { ok: true, questions: questions.slice(0, 3) };
}
