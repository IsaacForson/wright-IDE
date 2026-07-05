/**
 * Code-aware chunking (Phase 5.1). Heuristic, not AST: split at top-level
 * declaration boundaries and pack blocks into ~target-sized chunks with
 * file/line metadata. Works across languages without native tree-sitter
 * grammars; tree-sitter is the upgrade path if retrieval quality demands it.
 */

export interface Chunk {
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
  text: string;
}

const TARGET_LINES = 80;
const MAX_LINES = 160;
const MIN_LINES = 10;

/** Lines that likely begin a new top-level unit (function, class, section…). */
const BOUNDARY = new RegExp(
  "^(" +
    [
      "(export\\s+)?(default\\s+)?(abstract\\s+)?(async\\s+)?(function|class|interface|enum|namespace|type\\s+\\w|const\\s+\\w|let\\s+\\w|var\\s+\\w)", // TS/JS
      "(pub\\s+)?(async\\s+)?(fn|struct|enum|trait|impl|mod)\\b", // Rust
      "(def|class)\\s", // Python/Ruby
      "(func|type\\s+\\w+\\s+(struct|interface))\\b", // Go
      "(public|private|protected|static)\\s+[\\w<>\\[\\]]+\\s+\\w+\\s*\\(", // Java/C#
      "#{1,3}\\s", // Markdown headings
    ].join("|") +
    ")",
);

export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length <= MAX_LINES) {
    const text = content.trim();
    return text ? [{ path, startLine: 1, endLine: lines.length, text: content }] : [];
  }

  // Find boundary line indices (0-based). Line 0 is always a boundary.
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (BOUNDARY.test(lines[i]!)) boundaries.push(i);
  }
  boundaries.push(lines.length);

  // Pack consecutive blocks into chunks near TARGET_LINES.
  const chunks: Chunk[] = [];
  let start = 0;
  for (let b = 1; b < boundaries.length; b++) {
    const next = boundaries[b]!;
    const size = next - start;
    const isLast = b === boundaries.length - 1;
    if (size >= TARGET_LINES || isLast) {
      // Oversized single blocks get split by fixed window.
      if (size > MAX_LINES) {
        for (let w = start; w < next; w += MAX_LINES) {
          const end = Math.min(w + MAX_LINES, next);
          pushChunk(chunks, path, lines, w, end);
        }
      } else {
        pushChunk(chunks, path, lines, start, next);
      }
      start = next;
    }
  }
  return chunks;
}

function pushChunk(chunks: Chunk[], path: string, lines: string[], start: number, end: number): void {
  const text = lines.slice(start, end).join("\n");
  if (!text.trim()) return;
  // Merge tiny trailing chunks into the previous one.
  const prev = chunks[chunks.length - 1];
  if (prev && end - start < MIN_LINES && prev.endLine === start) {
    prev.text += "\n" + text;
    prev.endLine = end;
    return;
  }
  chunks.push({ path, startLine: start + 1, endLine: end, text });
}

/** The text actually embedded: a path header helps the model localize. */
export function embeddingText(chunk: Chunk): string {
  return `// ${chunk.path} (lines ${chunk.startLine}-${chunk.endLine})\n${chunk.text}`.slice(0, 8_000);
}
