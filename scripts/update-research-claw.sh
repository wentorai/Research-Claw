#!/usr/bin/env bash
# Research-Claw: pull latest from origin (ff-only), install deps, rebuild dashboard + extensions.
# Invoked by Settings → About → "Apply update" (rc.app.apply_update) or run manually from repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ ! -d .git ]]; then
  echo "Error: not a git repository. Clone https://github.com/wentorai/Research-Claw to use this script." >&2
  exit 1
fi
export PATH="$ROOT/node_modules/.bin:$PATH"
git pull --ff-only
pnpm install
pnpm build
echo "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)."
