#!/usr/bin/env bash
# Regenerate pnpm patch for Research-Claw (branding + .ResearchClaw bootstrap + chat history)
#
# This script creates a pnpm patch that:
#   1. Branding: process title, version output, error prefixes, daemon CLI
#   2. Bootstrap: .ResearchClaw/ directory override for workspace bootstrap files
#   3. Chat history: hide tool/toolResult rows so they do not consume the history window
#
# Usage:
#   ./scripts/apply-branding.sh
#
# Prerequisites:
#   - openclaw@target version installed in node_modules/ (run pnpm install first)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Generating Research-Claw patch (branding + bootstrap + chat history) ==="

if [ ! -d "node_modules/openclaw" ]; then
  echo "ERROR: node_modules/openclaw not found. Run 'pnpm install' first."
  exit 1
fi

VERSION=$(node -e "console.log(require('./node_modules/openclaw/package.json').version)")
PATCH_DIR="patches"
PATCH_FILE="${PATCH_DIR}/openclaw@${VERSION}.patch"

echo "OpenClaw version: $VERSION"
echo "Patch target: $PATCH_FILE"

if [ -f "$PATCH_FILE" ]; then
  echo "Removing existing patch: $PATCH_FILE"
  rm -f "$PATCH_FILE"
fi

# Drop stale patch keys from package.json before pnpm patch-commit
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.pnpm?.patchedDependencies) {
  for (const k of Object.keys(pkg.pnpm.patchedDependencies)) {
    if (k.startsWith('openclaw@')) delete pkg.pnpm.patchedDependencies[k];
  }
  if (Object.keys(pkg.pnpm.patchedDependencies).length === 0) {
    pkg.pnpm.patchedDependencies = {};
  }
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
"

mkdir -p "$PATCH_DIR"
EDIT_DIR="/tmp/oc-patch-$$"
rm -rf "$EDIT_DIR"
pnpm patch "openclaw@${VERSION}" --edit-dir "$EDIT_DIR"

echo ""

# ── 4. Branding: entry.js ─────────────────────────────────────────
ENTRY_FILE="$EDIT_DIR/dist/entry.js"
if [ ! -f "$ENTRY_FILE" ]; then
  echo "ERROR: $ENTRY_FILE not found. OpenClaw package structure may have changed."
  rm -rf "$EDIT_DIR"
  exit 1
fi

echo "Applying branding to entry.js ..."
sed -i '' 's/process\$1\.title = "openclaw"/process$1.title = "research-claw"/' "$ENTRY_FILE"
sed -i '' 's/`OpenClaw /`Research-Claw /g' "$ENTRY_FILE"
sed -i '' 's/\[openclaw\]/[research-claw]/g' "$ENTRY_FILE"

# ── 5. Branding: daemon-cli.js ────────────────────────────────────
DAEMON_FILE="$EDIT_DIR/dist/cli/daemon-cli.js"
if [ -f "$DAEMON_FILE" ]; then
  echo "Applying branding to daemon-cli.js ..."
  sed -i '' 's/Please upgrade OpenClaw/Please upgrade Research-Claw/g' "$DAEMON_FILE"
fi

# ── 6. Bootstrap: .ResearchClaw directory override ─────────────────
echo "Applying .ResearchClaw bootstrap override ..."

CHUNK_COUNT=0
for CHUNK in "$EDIT_DIR"/dist/workspace-*.js; do
  [ -f "$CHUNK" ] || continue
  if ! grep -q "async function loadWorkspaceBootstrapFiles" "$CHUNK" 2>/dev/null; then
    continue
  fi
  CHUNK_COUNT=$((CHUNK_COUNT + 1))
  BASENAME=$(basename "$CHUNK")

  sed -i '' '/^async function loadWorkspaceBootstrapFiles(dir) {/i\
function resolveBootstrapFilePath(resolvedDir, name) {\
	const rcPath = path.join(resolvedDir, ".ResearchClaw", name);\
	try { fs.accessSync(rcPath, fs.constants.F_OK); return rcPath; } catch { return path.join(resolvedDir, name); }\
}\
' "$CHUNK"

  for CONST in DEFAULT_AGENTS_FILENAME DEFAULT_SOUL_FILENAME DEFAULT_TOOLS_FILENAME \
               DEFAULT_IDENTITY_FILENAME DEFAULT_USER_FILENAME DEFAULT_HEARTBEAT_FILENAME \
               DEFAULT_BOOTSTRAP_FILENAME DEFAULT_MEMORY_FILENAME; do
    sed -i '' "s/filePath: path\.join(resolvedDir, ${CONST})/filePath: resolveBootstrapFilePath(resolvedDir, ${CONST})/g" "$CHUNK"
  done

  COUNT=$(grep -c "resolveBootstrapFilePath" "$CHUNK")
  echo "  $BASENAME: $COUNT occurrences (expect 9 = 1 def + 8 calls)"
  if [ "$COUNT" -lt 8 ]; then
    echo "  WARNING: unexpected count in $BASENAME! Manual review needed."
  fi
done

if [ "$CHUNK_COUNT" -eq 0 ]; then
  echo "ERROR: No workspace-* chunks with loadWorkspaceBootstrapFiles found!"
  rm -rf "$EDIT_DIR"
  exit 1
fi
echo "  Patched $CHUNK_COUNT workspace chunks."

# ── 7. Chat history: hide tool/toolResult from dashboard window ───
PROJECTION_FILE=$(find "$EDIT_DIR/dist" -name 'chat-display-projection-*.js' | head -1)
if [ -n "$PROJECTION_FILE" ] && [ -f "$PROJECTION_FILE" ]; then
  echo "Applying chat history toolResult filter to $(basename "$PROJECTION_FILE") ..."
  if ! grep -q 'roleContent.role === "toolResult"' "$PROJECTION_FILE"; then
    sed -i '' 's/if (!roleContent) return false;/if (!roleContent) return false;\
	if (roleContent.role === "toolResult" || roleContent.role === "tool") return true;/' "$PROJECTION_FILE"
  fi
  if grep -q 'roleContent.role === "toolResult"' "$PROJECTION_FILE"; then
    echo "  chat-display-projection: toolResult filter OK"
  else
    echo "  WARNING: toolResult filter not applied — manual review needed"
  fi
else
  echo "  WARNING: chat-display-projection chunk not found; skipping history filter"
fi

# ── 8. Commit patch ───────────────────────────────────────────────
echo ""
echo "Committing patch..."
pnpm patch-commit "$EDIT_DIR" --patches-dir "$PATCH_DIR"

# ── 9. Register patch in package.json ─────────────────────────────
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.pnpm = pkg.pnpm || {};
pkg.pnpm.patchedDependencies = pkg.pnpm.patchedDependencies || {};
const key = 'openclaw@${VERSION}';
pkg.pnpm.patchedDependencies[key] = 'patches/openclaw@${VERSION}.patch';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated package.json patchedDependencies:', key);
"

# ── 10. Verify ────────────────────────────────────────────────────
echo ""
echo "=== Verification ==="
BRAND_COUNT=$(grep -c "research-claw" "node_modules/openclaw/dist/entry.js" 2>/dev/null || echo 0)
echo "  Branding in entry.js: $BRAND_COUNT (expect >=6)"

for f in node_modules/openclaw/dist/workspace-*.js; do
  [ -f "$f" ] || continue
  grep -q "loadWorkspaceBootstrapFiles" "$f" 2>/dev/null || continue
  BC=$(grep -c "resolveBootstrapFilePath" "$f" 2>/dev/null || echo 0)
  echo "  Bootstrap in $(basename "$f"): $BC"
done

if [ -f "node_modules/openclaw/dist/chat-display-projection-CMTVNdR4.js" ]; then
  TC=$(grep -c 'roleContent.role === "toolResult"' node_modules/openclaw/dist/chat-display-projection-CMTVNdR4.js 2>/dev/null || echo 0)
  echo "  Chat history filter: $TC (expect >=1)"
fi

node node_modules/openclaw/dist/entry.js --version 2>/dev/null | head -1 || true

echo ""
echo "=== Patch generated: $PATCH_FILE ==="
echo "Commit the patch file and package.json to version control."
