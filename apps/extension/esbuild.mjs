import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Extension host: Node CJS, vscode module stays external. */
const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

/** Webview: browser IIFE bundle (React chat UI). */
const webviewCtx = await esbuild.context({
  entryPoints: ["webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
  // Codicon font: emit the ttf next to webview.css so its relative
  // url() resolves inside the webview.
  loader: { ".ttf": "file" },
  assetNames: "[name]",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("watching…");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
