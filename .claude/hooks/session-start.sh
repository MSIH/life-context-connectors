#!/bin/bash
set -euo pipefail

# SessionStart hook: bootstrap each connector's Node deps for Claude Code on the web / remote
# agents, so a fresh cloud checkout can run any connector without manual setup.
# Local sessions exit immediately — the developer already has deps installed.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"
echo "[session-start] remote environment detected — bootstrapping Node deps per connector"

git fetch origin --prune || true

# Root package.json, if the repo ever gets one (none today — each connector is self-contained).
if [ -f package.json ]; then
  if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi
fi

# Every connector folder is independent — install only where a package.json exists, and only
# when it actually declares dependencies (most connectors, e.g. devsession, have none).
for dir in */; do
  name="${dir%/}"
  [ -f "$dir/package.json" ] || continue
  if node -e "process.exit(Object.keys(require('./$dir/package.json').dependencies || {}).length ? 0 : 1)"; then
    echo "[session-start] npm install in $name"
    (cd "$dir" && { [ -f package-lock.json ] && { npm ci || npm install; } || npm install; })
  fi
done

echo "[session-start] Node deps ready ($(node --version 2>/dev/null || echo 'node?'))."
echo "[session-start] NOTE: connectors talk to a running LifeContext server (LIFECONTEXT_URL) and, for"
echo "[session-start]       some (e.g. devsession), a local chat-model endpoint. Cloud sandboxes"
echo "[session-start]       have neither by default — point each connector's .env at a reachable"
echo "[session-start]       instance, or verify against mock HTTP servers per that connector's README."
