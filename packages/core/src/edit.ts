/**
 * Search/replace edit application (the core of Phase 4, needed by the
 * edit_file tool from Phase 3 onward). The model emits the exact old text
 * and the new text; we locate and swap it. Exact match first, then a
 * whitespace-tolerant line match as fallback — models frequently get
 * trailing whitespace or indentation subtly wrong.
 */

export type EditOutcome =
  | { ok: true; content: string; matches: number }
  | { ok: false; error: string };

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean } = {},
): EditOutcome {
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are identical" };
  }

  // 1. Exact match.
  const exactCount = countOccurrences(content, oldString);
  if (exactCount > 0) {
    if (exactCount > 1 && !opts.replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${exactCount} locations. Add more surrounding context to make it unique, or set replace_all.`,
      };
    }
    return {
      ok: true,
      content: opts.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString),
      matches: exactCount,
    };
  }

  // 2. Whitespace-tolerant: compare lines with trailing whitespace stripped.
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  const starts: number[] = [];
  outer: for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trimEnd() !== oldLines[j]!.trimEnd()) continue outer;
    }
    starts.push(i);
  }

  if (starts.length === 0) {
    return {
      ok: false,
      error:
        "old_string not found in the file (even with whitespace-tolerant matching). " +
        "Re-read the file and copy the target text exactly.",
    };
  }
  if (starts.length > 1 && !opts.replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${starts.length} locations. Add more surrounding context to make it unique, or set replace_all.`,
    };
  }

  const newLines = newString.split("\n");
  const targets = opts.replaceAll ? starts : [starts[0]!];
  // Replace back-to-front so earlier indices stay valid.
  const result = [...contentLines];
  for (const start of [...targets].reverse()) {
    result.splice(start, oldLines.length, ...newLines);
  }
  return { ok: true, content: result.join("\n"), matches: targets.length };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
