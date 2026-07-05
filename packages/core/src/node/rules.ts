import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Project rules file (Phase 10): user-authored conventions the system
 * prompt always includes. `.wrightrules` wins; `.cursorrules` is honored
 * as a fallback since many repos already have one.
 */
export async function loadRulesFile(root: string): Promise<string | undefined> {
  for (const name of [".wrightrules", ".cursorrules"]) {
    try {
      const content = (await fs.readFile(path.join(root, name), "utf8")).trim();
      if (content) return content.slice(0, 8_000);
    } catch {
      // try next
    }
  }
  return undefined;
}
