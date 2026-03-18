#!/usr/bin/env bash
# Research-Claw First-Run Setup
# Creates config from template and launches Setup Wizard in browser.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=28789

echo "=== Research-Claw Setup ==="

# 1. Ensure config exists
if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    echo "[OK] Config created from template"
  else
    echo "[ERROR] config/openclaw.example.json not found. Is the project intact?"
    exit 1
  fi
else
  echo "[OK] Config already exists"
fi

# 2. Initialize L2/L3 bootstrap runtime files from .example templates
RC_DIR="workspace/.ResearchClaw"
[ ! -f "$RC_DIR/USER.md" ] && [ -f "$RC_DIR/USER.md.example" ] && \
  cp "$RC_DIR/USER.md.example" "$RC_DIR/USER.md" && echo "[OK] USER.md initialized"
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md" && echo "[OK] MEMORY.md initialized"
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md" && echo "[OK] BOOTSTRAP.md initialized"

# 3. Proxy (optional)
read -rp "HTTP Proxy (leave blank to skip, e.g. http://127.0.0.1:7890): " PROXY
if [ -n "$PROXY" ]; then
  echo "To apply proxy, edit config/openclaw.json and add:"
  echo "  \"env\": { \"vars\": { \"HTTP_PROXY\": \"$PROXY\", \"HTTPS_PROXY\": \"$PROXY\" } }"
  echo ""
fi

# 4. Persist OPENCLAW_CONFIG_PATH in shell profile
#    Ensures `openclaw config set/get` targets the RC project config.
PROJECT_ROOT="$(pwd)"
RC_ENV_LINE="export OPENCLAW_CONFIG_PATH=\"$PROJECT_ROOT/config/openclaw.json\""
RC_ENV_MARKER="OPENCLAW_CONFIG_PATH"
RC_PROFILE_WRITTEN=false

for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$p" ]; then
    if grep -q "$RC_ENV_MARKER" "$p" 2>/dev/null; then
      EXISTING_LINE="$(grep "$RC_ENV_MARKER" "$p" 2>/dev/null | head -1)"
      if [ "$EXISTING_LINE" != "$RC_ENV_LINE" ]; then
        sed -i.bak "s|.*${RC_ENV_MARKER}.*|${RC_ENV_LINE}|" "$p" 2>/dev/null && rm -f "${p}.bak"
        echo "[OK] Updated OPENCLAW_CONFIG_PATH in $p"
      else
        echo "[OK] OPENCLAW_CONFIG_PATH already set in $p"
      fi
      RC_PROFILE_WRITTEN=true
      break
    fi
  fi
done

if ! $RC_PROFILE_WRITTEN; then
  RC_SHELL_RC="$HOME/.bashrc"
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh) RC_SHELL_RC="$HOME/.zshrc" ;;
  esac
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ]; then
      RC_SHELL_RC="$p"
      break
    fi
  done
  if printf '\n# Research-Claw config path (added by setup.sh)\n%s\n' "$RC_ENV_LINE" >> "$RC_SHELL_RC" 2>/dev/null; then
    echo "[OK] OPENCLAW_CONFIG_PATH → $RC_SHELL_RC"
  else
    echo "[WARN] Could not write to $RC_SHELL_RC. Add manually:"
    echo "  $RC_ENV_LINE"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Run: source ~/.zshrc  (or restart terminal)"
echo "  2. Run: pnpm start"
echo "  3. Open: http://127.0.0.1:$PORT"
echo "  4. Follow the Setup Wizard to configure your LLM API Key"
echo ""
echo "Config: $PROJECT_ROOT/config/openclaw.json"
echo "CLI:    openclaw config set/get also edits the above file."
