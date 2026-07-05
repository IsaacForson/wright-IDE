// Patches user-visible "VS Code" strings in the BUILT app's localization
// bundles (welcome page walkthroughs etc). Runs against an app path:
//   node build/ide/patch-app-strings.mjs "VSCode-darwin-arm64/Wright.app"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const appPath = process.argv[2];
if (!appPath) {
  console.error("usage: node patch-app-strings.mjs <path-to-Wright.app>");
  process.exit(1);
}

// Exact user-facing strings shown on the Welcome page. Keep this list narrow —
// blanket-replacing "VS Code" everywhere would corrupt settings descriptions,
// URLs, and API names.
const replacements = [
  ["Get started with VS Code", "Get started with Wright"],
  ["Get Started with VS Code for the Web", "Get Started with Wright for the Web"],
  ["Discover the best customizations to make VS Code yours.", "Discover the best customizations to make Wright yours."],
  ["Get to know your new Editor", "Get to know Wright"],
];

const outDir = resolve(appPath, "Contents/Resources/app/out");
let patchedTotal = 0;
for (const file of ["nls.messages.json", "nls.messages.js"]) {
  const target = resolve(outDir, file);
  if (!existsSync(target)) continue;
  let content = readFileSync(target, "utf8");
  let patched = 0;
  for (const [from, to] of replacements) {
    // Strings live inside JSON/JS string literals; escape-sensitive chars absent.
    while (content.includes(from)) {
      content = content.replace(from, to);
      patched++;
    }
  }
  if (patched > 0) {
    writeFileSync(target, content);
    console.log(`${file}: ${patched} strings patched`);
    patchedTotal += patched;
  }
}
console.log(patchedTotal > 0 ? "App strings rebranded." : "No matching strings found (already patched?).");
