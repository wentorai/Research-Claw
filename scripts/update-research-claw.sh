#!/usr/bin/env bash
# Research-Claw: pull latest from origin (ff-only), install deps, rebuild dashboard + extensions.
# Invoked by Settings → About → "Apply update" (rc.app.apply_update) or run manually from repo root.
#
# Dual-remote fallback: if the default remote (often Gitee) has no new commits,
# automatically tries GitHub. Mirrors install.sh's Gitee→GitHub pattern.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ ! -d .git ]]; then
  echo "Error: not a git repository. Clone https://github.com/wentorai/Research-Claw to use this script." >&2
  exit 1
fi
export PATH="$ROOT/node_modules/.bin:$PATH"

GITHUB_REPO="https://github.com/wentorai/Research-Claw.git"

OLD_HEAD=$(git rev-parse HEAD)
git pull --ff-only 2>/dev/null || true

# If default remote had no new commits (Gitee may lag behind GitHub), try GitHub
if [ "$(git rev-parse HEAD)" = "$OLD_HEAD" ]; then
  git remote set-url github "$GITHUB_REPO" 2>/dev/null \
    || git remote add github "$GITHUB_REPO" 2>/dev/null \
    || true
  if git fetch github main 2>/dev/null; then
    git merge --ff-only github/main 2>/dev/null || true
  fi
fi

pnpm install
pnpm build

# Update research-plugins (skills + agent tools)
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
if [ -d "$PLUGIN_DIR" ]; then
  RP_LOG="$(mktemp)"
  echo "[update-research-claw] Updating research-plugins..."
  TMP_CFG="$(mktemp)"; echo '{}' > "$TMP_CFG"
  if OPENCLAW_CONFIG_PATH="$TMP_CFG" node ./node_modules/openclaw/dist/entry.js plugins install @wentorai/research-plugins >"$RP_LOG" 2>&1; then
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    echo "[update-research-claw] research-plugins → v${NEW_VER}"
  else
    echo "[update-research-claw] research-plugins update failed (non-critical). Details:" >&2
    tail -3 "$RP_LOG" >&2
  fi
  rm -f "$TMP_CFG" "$RP_LOG"
fi

echo "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)."
