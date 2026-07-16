#!/usr/bin/env bash
# Builds Wright.app: a rebranded VS Code (Code-OSS) fork with the Wright
# extension baked in as a built-in. Run from the repo root:
#   bash build/ide/build-ide.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VSCODE="$ROOT/vscode"
NODE_DIR="$ROOT/build/ide/node-runtime"

if [ ! -d "$VSCODE" ]; then
  echo "vscode/ source tree not found — download it first" >&2
  exit 1
fi

# --- 1. Node version required by the VS Code build ---
REQUIRED_NODE="$(cat "$VSCODE/.nvmrc" | tr -d 'v[:space:]')"
echo "==> VS Code build requires Node $REQUIRED_NODE"

CURRENT_NODE="$(node -v | tr -d 'v')"
if [ "$CURRENT_NODE" != "$REQUIRED_NODE" ]; then
  NODE_HOME="$NODE_DIR/node-v$REQUIRED_NODE-darwin-arm64"
  if [ ! -x "$NODE_HOME/bin/node" ]; then
    echo "==> Downloading Node v$REQUIRED_NODE (local to this build, won't touch your system node)"
    mkdir -p "$NODE_DIR"
    curl -fsSL --retry 5 "https://nodejs.org/dist/v$REQUIRED_NODE/node-v$REQUIRED_NODE-darwin-arm64.tar.gz" \
      | tar -xz -C "$NODE_DIR"
  fi
  export PATH="$NODE_HOME/bin:$PATH"
fi
echo "==> Using node $(node -v) / npm $(npm -v)"

# --- 2. Rebrand as Wright ---
node "$ROOT/build/ide/patch-product.mjs"

# --- 3. Install VS Code build dependencies ---
cd "$VSCODE"
if [ ! -d node_modules ]; then
  echo "==> npm ci (this takes 10-20 min: native modules compile)"
  npm ci
else
  echo "==> node_modules present, skipping npm ci"
fi

# --- 4. Build the macOS arm64 app ---
echo "==> Building Wright.app (30-60 min on first run)"
NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- vscode-darwin-arm64-min

APP="$ROOT/VSCode-darwin-arm64/Wright.app"
if [ ! -d "$APP" ]; then
  # non-min builds land in the same folder but keep the OSS name if branding
  # didn't apply; fail loudly so we can inspect.
  echo "Build finished but $APP not found — check $ROOT/VSCode-darwin-arm64/" >&2
  ls "$ROOT/VSCode-darwin-arm64/" || true
  exit 1
fi

# --- 5. Bake the Wright extension in as a built-in (keep Copilot — Wright is a Chat tab beside it) ---
echo "==> Bundling Wright extension into the app"
BUILTIN="$APP/Contents/Resources/app/extensions/wright.wright-extension"
rm -rf "$BUILTIN"
mkdir -p "$BUILTIN"
cp -R "$ROOT/apps/extension/package.json" "$ROOT/apps/extension/dist" "$ROOT/apps/extension/media" "$BUILTIN/"
node "$ROOT/build/ide/patch-app-strings.mjs" "$APP"

# --- 6. Ad-hoc sign so Gatekeeper allows it locally ---
echo "==> Ad-hoc signing"
codesign --force --deep --sign - "$APP"

echo ""
echo "DONE: $APP"
echo "Install with: cp -R \"$APP\" /Applications/"
