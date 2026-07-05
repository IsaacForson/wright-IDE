// Rebrands the VS Code OSS source tree as Wright by patching product.json.
// Run from repo root: node build/ide/patch-product.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const productPath = resolve("vscode/product.json");
const product = JSON.parse(readFileSync(productPath, "utf8"));

Object.assign(product, {
  nameShort: "Wright",
  nameLong: "Wright",
  applicationName: "wright",
  dataFolderName: ".wright",
  serverApplicationName: "wright-server",
  serverDataFolderName: ".wright-server",
  tunnelApplicationName: "wright-tunnel",
  urlProtocol: "wright",
  darwinBundleIdentifier: "com.wright.ide",
  win32MutexName: "wright",
  win32DirName: "Wright",
  win32NameVersion: "Wright",
  win32RegValueName: "Wright",
  win32AppUserModelId: "Wright.Wright",
  win32ShellNameShort: "Wright",
  licenseName: "MIT",
  reportIssueUrl: "https://github.com/IsaacForson/wright-IDE/issues",
  quality: "stable",
  // Forks may not use Microsoft's marketplace; Open VSX is the standard replacement.
  extensionsGallery: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
  },
});

writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
console.log("product.json patched: app is now Wright");
