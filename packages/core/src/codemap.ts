/**
 * Codemap (Phase 12 / Tier-1): a lightweight architecture map built purely
 * from the import graph — no embeddings, no build step. Given the source files
 * it parses import specifiers, resolves the internal ones to other files in the
 * set, and summarizes modules (top-level dirs), import edges, and the most
 * depended-on "key files". Framework-agnostic and easy to unit test.
 */

export interface CodemapInput {
  /** Workspace-relative POSIX path, e.g. "packages/core/src/agent.ts". */
  path: string;
  content: string;
}

export interface CodemapFile {
  path: string;
  /** Top-level grouping (first path segment, or "." for root files). */
  module: string;
  /** Internal files this file imports (resolved, deduped). */
  imports: string[];
  /** How many internal files import this one. */
  importedBy: number;
}

export interface CodemapModule {
  name: string;
  files: number;
  /** Distinct other modules this module imports from. */
  dependsOn: string[];
}

export interface Codemap {
  files: CodemapFile[];
  modules: CodemapModule[];
  /** Directed internal import edges (from → to), file-level. */
  edges: Array<{ from: string; to: string }>;
  /** Most-imported files first (in-degree), capped by the caller. */
  keyFiles: Array<{ path: string; importedBy: number }>;
}

const IMPORT_RE =
  /(?:import\s[^'"]*from\s*|import\s*|export\s[^'"]*from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
// Python: `import x`, `from x import y`, and relative `from . import y`.
const PY_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Collect raw import specifiers from a file's source. */
function specifiers(path: string, content: string): string[] {
  const out: string[] = [];
  if (/\.(py)$/.test(path)) {
    for (const m of content.matchAll(PY_RE)) {
      const spec = m[1] ?? m[2];
      if (spec) out.push(spec);
    }
    return out;
  }
  for (const m of content.matchAll(IMPORT_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** Normalize a POSIX-ish path, resolving "." and ".." segments. */
function normalize(p: string): string {
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** Resolve a relative import specifier to a file in the set, or undefined. */
function resolve(fromPath: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined; // bare = external package
  const base = normalize(`${dirname(fromPath)}/${spec}`);
  const candidates = [
    base,
    ...JS_EXT.map((e) => base + e),
    ...JS_EXT.map((e) => `${base}/index${e}`),
    `${base}/__init__.py`,
    `${base}.py`,
  ];
  return candidates.find((c) => known.has(c));
}

function moduleOf(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

export function buildCodemap(input: CodemapInput[], opts: { keyFileLimit?: number } = {}): Codemap {
  const known = new Set(input.map((f) => f.path));
  const importsByFile = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const p of known) inDegree.set(p, 0);

  for (const f of input) {
    const resolved = new Set<string>();
    for (const spec of specifiers(f.path, f.content)) {
      const target = resolve(f.path, spec, known);
      if (target && target !== f.path) resolved.add(target);
    }
    const list = [...resolved];
    importsByFile.set(f.path, list);
    for (const t of list) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
      edges.push({ from: f.path, to: t });
    }
  }

  const files: CodemapFile[] = input
    .map((f) => ({
      path: f.path,
      module: moduleOf(f.path),
      imports: importsByFile.get(f.path) ?? [],
      importedBy: inDegree.get(f.path) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Module-level rollup.
  const modMap = new Map<string, { files: number; deps: Set<string> }>();
  for (const f of files) {
    const entry = modMap.get(f.module) ?? { files: 0, deps: new Set<string>() };
    entry.files += 1;
    for (const imp of f.imports) {
      const dm = moduleOf(imp);
      if (dm !== f.module) entry.deps.add(dm);
    }
    modMap.set(f.module, entry);
  }
  const modules: CodemapModule[] = [...modMap.entries()]
    .map(([name, v]) => ({ name, files: v.files, dependsOn: [...v.deps].sort() }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));

  const keyFiles = files
    .filter((f) => f.importedBy > 0)
    .map((f) => ({ path: f.path, importedBy: f.importedBy }))
    .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
    .slice(0, opts.keyFileLimit ?? 15);

  return { files, modules, edges, keyFiles };
}
