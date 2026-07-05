import type { Tool } from "./tools.js";

/**
 * read_url tool: fetch a web page the user shared (or the agent found) and
 * return its readable text. Crude readability — strip script/style/nav,
 * collapse tags — which is plenty for blogs, docs, and READMEs.
 */

const MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

export function createReadUrlTool(): Tool {
  return {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "read_url",
        description:
          "Fetch a web page by URL and return its readable text content. Use when the user shares a link " +
          "(blog post, docs, article) to use as reference, or to read a specific page found via web_search.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    async execute(args, signal) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) return { ok: false, output: "read_url needs a full http(s) URL" };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; WrightAgent/0.1)", Accept: "text/html,text/plain,*/*" },
        });
        clearTimeout(timer);
        if (!res.ok) return { ok: false, output: `HTTP ${res.status} fetching ${url}` };
        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const text = contentType.includes("html") ? htmlToText(body) : body;
        const out = text.slice(0, MAX_CHARS);
        return { ok: true, output: `[${url}]\n${out}${text.length > MAX_CHARS ? "\n… [truncated]" : ""}` };
      } catch (err) {
        return { ok: false, output: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|aside|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Preserve structure hints before stripping tags.
  s = s
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => line || arr[i - 1])
    .join("\n")
    .replace(/[ \t]{2,}/g, " ");
}
