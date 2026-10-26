#!/usr/bin/env bash
# Bootstrap script for clickup-mcp-extras.
# Installs npm deps, builds TypeScript, prints the `claude mcp add` command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> clickup-mcp-extras setup"
echo "    path: $SCRIPT_DIR"
echo ""

# Node check
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH. Install Node.js >= 18 first." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required (found $(node --version))." >&2
  exit 1
fi

# .env check
if [ ! -f .env ]; then
  echo "WARNING: .env not found. Copying from .env.example..."
  cp .env.example .env
  echo ""
  echo "  --> Edit .env now and set CLICKUP_API_TOKEN, then re-run this script."
  echo "      (Generate token: app.clickup.com -> Settings -> Apps -> API Token)"
  exit 1
fi

if grep -q "pk_your_token_here" .env; then
  echo "ERROR: .env still contains the placeholder 'pk_your_token_here'." >&2
  echo "       Set CLICKUP_API_TOKEN to your real ClickUp Personal API Token." >&2
  exit 1
fi

# Install + build
echo "==> npm install"
npm install

echo ""
echo "==> npm run build"
npm run build

# Claude check
if ! command -v claude >/dev/null 2>&1; then
  echo ""
  echo "WARNING: 'claude' CLI not found in PATH. Skipping registration step." >&2
  echo "         Install Claude Code first, then run:" >&2
  echo "         claude mcp add clickup-extras --scope user -- node $SCRIPT_DIR/dist/index.js" >&2
  exit 0
fi

# Already registered?
if claude mcp list 2>/dev/null | grep -q "^clickup-extras:"; then
  echo ""
  echo "==> clickup-extras already registered in Claude Code."
  echo "    Run 'claude mcp list' to verify status."
  echo "    Restart Claude Code (or /mcp -> reconnect clickup-extras) to pick up the new build."
  exit 0
fi

echo ""
echo "==> Registering MCP server with Claude Code (user scope)..."
claude mcp add clickup-extras --scope user -- node "$SCRIPT_DIR/dist/index.js"

echo ""
echo "==> Done."
echo "    Verify: claude mcp list"
echo "    Then restart Claude Code (/exit + relaunch, or /mcp -> reconnect) to load the tools."
