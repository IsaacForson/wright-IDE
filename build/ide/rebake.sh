#!/usr/bin/env bash
# Rebuilds the Wright extension and bakes it into Wright.app (a few seconds).
# Usage, from the repo root:
#   bash build/ide/rebake.sh
# Updates the app in VSCode-darwin-arm64/ and, if present, /Applications/Wright.app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> Building @wright/core + extension"
pnpm --filter @wright/core build
pnpm --filter wright-extension build

update_app() {
  local APP="$1"
  [ -d "$APP" ] || return 0
  local DEST="$APP/Contents/Resources/app/extensions/wright.wright-extension"
  echo "==> Updating $APP"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R apps/extension/package.json apps/extension/dist apps/extension/media "$DEST/"
  # Do not strip Copilot — Wright lives as a Chat panel tab beside the host chat.
  node "$ROOT/build/ide/patch-app-strings.mjs" "$APP"
  codesign --force --deep --sign - "$APP"
}

update_app "$ROOT/VSCode-darwin-arm64/Wright.app"
update_app "/Applications/Wright.app"

echo "DONE — restart Wright to load the new version."
