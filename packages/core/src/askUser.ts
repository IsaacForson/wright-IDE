import type { Tool } from "./tools.js";

/**
 * Structured clarifying questions (Cursor-style AskQuestion).
 * The host injects a waiter that parks the agent until the user submits
 * picks in the chat UI — topics stay out of the option list by design.
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
          "Ask the user one or more multiple-choice clarifying questions in the chat UI. " +
          "Use this INSTEAD of writing bullet-list questions in plain text whenever a decision " +
          "is needed (stack, platform, scope, features, etc.). " +
          "Each question's `prompt` is the topic; `options` are ONLY the selectable answers — " +
          "never put the topic/header itself in options. " +
          "Arguments MUST be a single JSON object (no markdown fences, no text after the closing brace). " +
          "After calling this tool, STOP and wait for the user's answer (do not assume or continue).",
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
      const raw = args.questions;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, output: "ask_user requires a non-empty questions array." };
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
          // Never allow the prompt itself to sneak in as an option.
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
          output:
            "ask_user needs each question to have a prompt (topic) and at least 2 answer options. " +
            "Do not put topics in the options list.",
        };
      }
      try {
        const answer = await waitForAnswers({ questions }, signal);
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
