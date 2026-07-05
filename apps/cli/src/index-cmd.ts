/**
 * Build or update the codebase index for a workspace.
 *
 * Usage: pnpm index -- --root <dir>
 */
import { ModelClient, nvidiaProvider } from "@wright/core";
import { Indexer } from "@wright/core/node";
import { requireEnv } from "./env.js";
import * as path from "node:path";

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf("--root");
const root = path.resolve(rootIdx !== -1 ? argv[rootIdx + 1]! : process.env.INIT_CWD ?? process.cwd());

const env = requireEnv();
const embedModel = process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nv-embedcode-7b-v1";
const client = new ModelClient(nvidiaProvider({ apiKey: env.apiKey, chatModel: env.model }));

console.log(`Indexing ${root} with ${embedModel}\n`);
const started = Date.now();
const indexer = await Indexer.load(client, embedModel, root);

const result = await indexer.sync({
  onProgress: (p) => {
    if (p.phase === "embedding") {
      process.stdout.write(`\r\x1b[2K  embedding ${p.processed + 1}/${p.total}: ${p.currentFile ?? ""}`);
    }
  },
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write("\r\x1b[2K");
console.log(
  `Done in ${secs}s — ${result.embedded} file(s) embedded, ${result.removed} removed, ` +
    `${result.total} files / ${indexer.store.chunkCount} chunks in index.`,
);
console.log(`Index stored at ${Indexer.indexPath(root)}`);
