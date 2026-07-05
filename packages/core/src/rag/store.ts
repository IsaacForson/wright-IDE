import type { Chunk } from "./chunker.js";

/**
 * In-memory vector store with disk-format (de)serialization (Phase 5.2).
 * Brute-force cosine over normalized Float32 vectors — at single-repo scale
 * (thousands of chunks) this is a few milliseconds; a real ANN store
 * (LanceDB) is the upgrade path, not the starting point.
 */

export interface StoredChunk extends Chunk {
  vector: Float32Array; // L2-normalized
}

export interface FileEntry {
  hash: string;
  chunks: StoredChunk[];
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

interface SerializedFile {
  hash: string;
  chunks: Array<Omit<Chunk, "path"> & { v: string }>; // v = base64 Float32
}

export interface SerializedIndex {
  version: 1;
  model: string;
  dims: number;
  files: Record<string, SerializedFile>;
}

export class VectorStore {
  private files = new Map<string, FileEntry>();

  constructor(
    public readonly model: string,
    public dims = 0,
  ) {}

  fileHash(path: string): string | undefined {
    return this.files.get(path)?.hash;
  }

  get fileCount(): number {
    return this.files.size;
  }

  get chunkCount(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.chunks.length;
    return n;
  }

  setFile(path: string, hash: string, chunks: Chunk[], vectors: number[][]): void {
    const stored: StoredChunk[] = chunks.map((c, i) => {
      const v = normalize(Float32Array.from(vectors[i]!));
      if (this.dims === 0) this.dims = v.length;
      return { ...c, vector: v };
    });
    this.files.set(path, { hash, chunks: stored });
  }

  removeFile(path: string): void {
    this.files.delete(path);
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  search(queryVector: number[], k = 8): SearchHit[] {
    const q = normalize(Float32Array.from(queryVector));
    const hits: SearchHit[] = [];
    for (const file of this.files.values()) {
      for (const chunk of file.chunks) {
        const score = dot(q, chunk.vector);
        hits.push({ chunk: { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text }, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  serialize(): SerializedIndex {
    const files: Record<string, SerializedFile> = {};
    for (const [path, entry] of this.files) {
      files[path] = {
        hash: entry.hash,
        chunks: entry.chunks.map((c) => ({
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          v: toBase64(c.vector),
        })),
      };
    }
    return { version: 1, model: this.model, dims: this.dims, files };
  }

  static deserialize(data: SerializedIndex): VectorStore {
    const store = new VectorStore(data.model, data.dims);
    for (const [path, file] of Object.entries(data.files)) {
      store.files.set(path, {
        hash: file.hash,
        chunks: file.chunks.map((c) => ({
          path,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          vector: fromBase64(c.v),
        })),
      });
    }
    return store;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

function toBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(s: string): Float32Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
