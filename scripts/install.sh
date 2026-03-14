#!/usr/bin/env bash
# ============================================================================
# Research-Claw (科研龙虾) — Install / Update / Start
# Hosted at: https://wentor.ai/install.sh
#
# Usage:
#   curl -fsSL https://wentor.ai/install.sh | bash
#
# Idempotent: first run = install, subsequent runs = update + start.
# All configuration is handled in the browser via Setup Wizard.
#
# Options (environment variables):
#   INSTALL_DIR  — where to install (default: ~/research-claw)
#   PORT         — gateway port (default: 28789)
#   SKIP_START   — set to 1 to install only, don't launch gateway
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/research-claw}"
PORT="${PORT:-28789}"
REPO="https://github.com/wentorai/Research-Claw.git"
NODE_MIN=22
PNPM_VERSION=9
ISSUES_URL="https://github.com/wentorai/Research-Claw/issues"

# --- Colors (disabled in pipes) ---
if [ -t 1 ] && [ -t 2 ]; then
  R='\033[38;2;239;68;68m' G='\033[38;2;34;197;94m' C='\033[38;2;34;211;238m'
  Y='\033[38;2;250;204;21m' B='\033[1m' D='\033[2m' N='\033[0m'
else
  R='' G='' C='' Y='' B='' D='' N=''
fi
ok()   { printf "${G}  ✓${N} %s\n" "$1"; }
info() { printf "${C}  ▸${N} %s\n" "$1"; }
warn() { printf "${Y}  ⚠${N} %s\n" "$1"; }
die()  { printf "${R}  ✗ %s${N}\n" "$1" >&2; printf "  ${D}Report: ${ISSUES_URL}${N}\n" >&2; exit 1; }

# Global error trap — catch unexpected failures from set -euo pipefail
trap 'printf "\n${R}  ✗ Unexpected error at line $LINENO${N}\n" >&2; printf "  ${D}Report: ${ISSUES_URL}${N}\n" >&2; exit 1' ERR

# --- Banner ---
printf "\n${R}"
cat <<'ART'
    ____                              _        ____ _
   |  _ \ ___  ___  ___  __ _ _ __ ___| |__    / ___| | __ ___      __
   | |_) / _ \/ __|/ _ \/ _` | '__/ __| '_ \  | |   | |/ _` \ \ /\ / /
   |  _ <  __/\__ \  __/ (_| | | | (__| | | | | |___| | (_| |\ V  V /
   |_| \_\___||___/\___|\__,_|_|  \___|_| |_|  \____|_|\__,_| \_/\_/
ART
printf "${N}\n  ${B}科研龙虾 — AI-Powered Local Research Assistant${N}\n"
printf "  ${D}https://wentor.ai${N}\n\n"

# --- [1/8] Platform ---
OS="$(uname -s)"
case "$OS" in
  Darwin) RC_OS=mac ;;
  Linux)  RC_OS=linux ;;
  *)      die "Unsupported OS: $OS. Use macOS or Linux." ;;
esac
info "Platform: $OS / $(uname -m)"

# --- [2/8] Git ---
if ! command -v git &>/dev/null; then
  if [ "$RC_OS" = linux ]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq git
  else
    die "git not found. Run: xcode-select --install"
  fi
fi
ok "git"

# --- [3/8] Build tools (macOS + Linux) ---
if [ "$RC_OS" = mac ]; then
  # Xcode CLT is required for native module compilation (better-sqlite3)
  if ! xcode-select -p &>/dev/null; then
    info "Installing Xcode Command Line Tools (required for native modules)..."
    xcode-select --install 2>/dev/null || true
    warn "Please complete Xcode CLT installation in the popup, then re-run this script."
    exit 1
  fi
  # Python 3 is required by node-gyp for native module compilation
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found. Native module compilation may fail."
    warn "Install via: brew install python3  OR  xcode-select --install"
  fi
else
  # Linux: build-essential + python3 + unzip (required by fnm installer) + curl
  LINUX_PKGS=""
  command -v make &>/dev/null && command -v g++ &>/dev/null || LINUX_PKGS="build-essential python3"
  command -v unzip &>/dev/null || LINUX_PKGS="$LINUX_PKGS unzip"
  command -v curl &>/dev/null || LINUX_PKGS="$LINUX_PKGS curl"
  if [ -n "$LINUX_PKGS" ]; then
    info "Installing system dependencies: $LINUX_PKGS"
    sudo apt-get update -qq && sudo apt-get install -y -qq $LINUX_PKGS
  fi
fi

# --- [4/8] Node.js 22+ ---
# Supports nvm, fnm, and system Node. Prefers existing version manager.
install_node_fnm() {
  info "Installing Node.js $NODE_MIN via fnm..."
  if ! command -v fnm &>/dev/null; then
    local tmp; tmp="$(mktemp)"
    curl -fsSL https://fnm.vercel.app/install -o "$tmp"
    bash "$tmp" --install-dir "$HOME/.local/share/fnm" --skip-shell
    rm -f "$tmp"
    export PATH="$HOME/.local/share/fnm:$PATH"
  fi
  eval "$(fnm env --shell bash 2>/dev/null || true)"
  fnm install "$NODE_MIN" --progress=never && fnm use "$NODE_MIN" && fnm default "$NODE_MIN"

  # Persist to shell profile
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ] && ! grep -q 'fnm env' "$p" 2>/dev/null; then
      printf '\n# fnm (added by Research-Claw)\nexport PATH="$HOME/.local/share/fnm:$PATH"\neval "$(fnm env --use-on-cd --shell bash)"\n' >> "$p"
      break
    fi
  done
}

install_node_nvm() {
  info "Installing Node.js $NODE_MIN via nvm..."
  # Source nvm if not already loaded
  if [ -z "${NVM_DIR:-}" ]; then
    export NVM_DIR="$HOME/.nvm"
  fi
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MIN" && nvm use "$NODE_MIN" && nvm alias default "$NODE_MIN"
}

ensure_node() {
  # Check current Node version
  if command -v node &>/dev/null; then
    NODE_V="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$NODE_V" -ge "$NODE_MIN" ] 2>/dev/null; then
      ok "Node.js $(node -v)"
      return 0
    fi
  fi

  # Node missing or too old — try version managers in order
  # 1. nvm (if user already has it)
  if command -v nvm &>/dev/null || [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    install_node_nvm
  # 2. fnm (if user already has it, or install fresh)
  else
    install_node_fnm
  fi

  # Verify installation
  if ! command -v node &>/dev/null; then
    die "Node.js installation failed. Install Node.js $NODE_MIN+ manually: https://nodejs.org"
  fi
  NODE_V="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_V" -lt "$NODE_MIN" ] 2>/dev/null; then
    die "Node.js $(node -v) installed but $NODE_MIN+ required. Please upgrade manually."
  fi
  ok "Node.js $(node -v)"
}

ensure_node

# --- [4/8 cont.] pnpm ---
if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  npm install -g "pnpm@$PNPM_VERSION" 2>/dev/null || true
fi
if ! command -v pnpm &>/dev/null; then
  die "pnpm installation failed. Install manually: npm install -g pnpm@$PNPM_VERSION"
fi
ok "pnpm $(pnpm -v)"

# --- [5/8] Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --rebase --autostash 2>/dev/null || git pull
  ok "Updated"
else
  info "Cloning to $INSTALL_DIR ..."
  if ! git clone --depth 1 "$REPO" "$INSTALL_DIR" 2>&1; then
    die "Failed to clone repository. Check your network connection and try again."
  fi
  cd "$INSTALL_DIR"
  ok "Cloned"
fi

# --- Force git HTTPS (prevent SSH clone failures for git+ dependencies) ---
# @whiskeysockets/baileys references libsignal-node via git+https URL;
# some environments convert this to SSH (git@github.com:...) which fails
# without SSH keys. This env-level override forces HTTPS without modifying
# the user's global git config.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.https://github.com/.insteadOf"
export GIT_CONFIG_VALUE_0="git@github.com:"

# --- [6/8] Install + build ---
info "Installing dependencies..."
if ! (pnpm install --frozen-lockfile 2>/dev/null || pnpm install); then
  die "Dependency installation failed. Try: cd $INSTALL_DIR && pnpm install"
fi
ok "Dependencies installed"

if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    ok "Config created"
  fi
fi

info "Building..."
BUILD_LOG="$(mktemp)"
if pnpm build >"$BUILD_LOG" 2>&1; then
  tail -3 "$BUILD_LOG"
else
  tail -20 "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  die "Build failed. Try: cd $INSTALL_DIR && pnpm build"
fi
rm -f "$BUILD_LOG"
ok "Build complete"

# --- Verify dashboard build ---
if [ ! -d "dashboard/dist" ] || [ ! -f "dashboard/dist/index.html" ]; then
  warn "Dashboard build missing. Rebuilding..."
  pnpm build:dashboard 2>&1 | tail -3 || true
  if [ ! -f "dashboard/dist/index.html" ]; then
    warn "Dashboard build failed. The gateway will start but the web UI may not load."
    warn "Try: cd $INSTALL_DIR && pnpm build:dashboard"
  else
    ok "Dashboard rebuilt"
  fi
fi

# --- [7/8] Rebuild native modules if ABI mismatch ---
# better-sqlite3 is a C++ addon compiled against a specific Node ABI.
# The gateway may run under a different Node (e.g. conda) than system node,
# so we detect the actual Node that openclaw uses and rebuild with THAT one.
SQLITE_NODE="node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if ls $SQLITE_NODE &>/dev/null; then
  # Resolve the better-sqlite3 package directory (absolute path for pnpm compatibility)
  SQLITE_PKG="$(cd "$(dirname "$(dirname "$(ls $SQLITE_NODE | head -1)")")" && pwd)"

  # Detect which Node the gateway actually uses.
  # The openclaw CLI activates conda env "openclaw" which has its own Node.
  # Priority: 1) conda openclaw env Node  2) node next to openclaw binary  3) system node
  GW_NODE="node"
  # Check conda openclaw environment first (most reliable method)
  if command -v conda &>/dev/null; then
    CONDA_OC_PREFIX="$(conda env list 2>/dev/null | grep "^openclaw " | awk '{print $NF}')"
    if [ -n "$CONDA_OC_PREFIX" ] && [ -x "$CONDA_OC_PREFIX/bin/node" ]; then
      GW_NODE="$CONDA_OC_PREFIX/bin/node"
    fi
  fi
  # Fallback: check for node binary next to openclaw command
  if [ "$GW_NODE" = "node" ] && command -v openclaw &>/dev/null; then
    OC_PATH="$(command -v openclaw)"
    if [ -L "$OC_PATH" ]; then OC_PATH="$(readlink -f "$OC_PATH")"; fi
    OC_DIR="$(dirname "$OC_PATH")"
    if [ -x "$OC_DIR/node" ]; then
      GW_NODE="$OC_DIR/node"
    fi
  fi

  # Test ABI compatibility using absolute path (pnpm strict mode won't resolve bare specifiers)
  if ! "$GW_NODE" -e "require('$SQLITE_PKG')" 2>/dev/null; then
    info "Rebuilding native modules for $("$GW_NODE" -v) (gateway Node)..."
    GW_NPM_ROOT="$("$GW_NODE" -e "console.log(require('child_process').execSync('npm root -g', {env:{...process.env,PATH:process.env.PATH}}).toString().trim())" 2>/dev/null || echo "")"
    GW_NODEGYP=""
    if [ -n "$GW_NPM_ROOT" ] && [ -f "$GW_NPM_ROOT/npm/node_modules/node-gyp/bin/node-gyp.js" ]; then
      GW_NODEGYP="$GW_NPM_ROOT/npm/node_modules/node-gyp/bin/node-gyp.js"
    fi
    REBUILD_OK=false
    # Ensure the gateway's Node is first in PATH during rebuild
    GW_NODE_DIR="$(dirname "$GW_NODE")"
    if [ -n "$GW_NODEGYP" ]; then
      (cd "$SQLITE_PKG" && PATH="$GW_NODE_DIR:$PATH" "$GW_NODE" "$GW_NODEGYP" rebuild &>/dev/null) && REBUILD_OK=true
    else
      (cd "$SQLITE_PKG" && PATH="$GW_NODE_DIR:$PATH" npx --yes node-gyp rebuild &>/dev/null) && REBUILD_OK=true
    fi
    if $REBUILD_OK; then
      ok "Native modules rebuilt"
    else
      warn "Native module rebuild failed. The gateway may still work if openclaw uses its own Node."
    fi
  else
    ok "Native modules ABI compatible"
  fi
else
  # No compiled .node file found — native module compilation likely failed during install.
  info "Native module binary not found. Running pnpm rebuild..."
  pnpm rebuild 2>&1 | tail -3 || true
  if ls $SQLITE_NODE &>/dev/null; then
    ok "Native modules compiled"
  else
    warn "better-sqlite3 compilation failed. The gateway may not start."
    if [ "$RC_OS" = mac ]; then
      warn "Ensure Xcode CLT is installed: xcode-select --install"
      warn "Ensure python3 is available: python3 --version"
    fi
  fi
fi

# --- [8/8] Register research-plugins (skills + agent tools) ---
# Installed via OpenClaw's plugin system (npm pack → ~/.openclaw/extensions/).
# NOT loaded from node_modules — avoids pnpm hardlink rejection.
OPENCLAW="node ./node_modules/openclaw/dist/entry.js"
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
info "Installing research-plugins..."
if [ -d "$PLUGIN_DIR" ]; then
  # Update existing: backup → delete → install → restore on failure
  CURRENT_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
  cp -r "$PLUGIN_DIR" "${PLUGIN_DIR}.bak" 2>/dev/null || true
  rm -rf "$PLUGIN_DIR"
  if $OPENCLAW plugins install @wentorai/research-plugins &>/dev/null; then
    rm -rf "${PLUGIN_DIR}.bak"
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    if [ "$CURRENT_VER" = "$NEW_VER" ]; then
      ok "Research-plugins v${NEW_VER} (431 skills, 13 tools)"
    else
      ok "Research-plugins updated: v${CURRENT_VER} → v${NEW_VER}"
    fi
  else
    # Restore backup on failure
    if [ -d "${PLUGIN_DIR}.bak" ]; then
      mv "${PLUGIN_DIR}.bak" "$PLUGIN_DIR"
      warn "research-plugins update failed. Kept existing v${CURRENT_VER}."
    else
      warn "research-plugins update failed. You can retry later:"
      printf "    openclaw plugins install @wentorai/research-plugins\n"
    fi
  fi
else
  # Fresh install
  if $OPENCLAW plugins install @wentorai/research-plugins &>/dev/null; then
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    ok "Research-plugins v${NEW_VER} (431 skills, 13 tools)"
  else
    warn "research-plugins install failed (offline?). You can retry later:"
    printf "    openclaw plugins install @wentorai/research-plugins\n"
  fi
fi

# --- Done ---
printf "\n  ${G}${B}Ready!${N}\n\n"
printf "  ${B}Dashboard:${N}  ${C}http://127.0.0.1:$PORT${N}\n"
printf "  ${B}Location:${N}   $INSTALL_DIR\n"
printf "  ${B}Start:${N}      cd $INSTALL_DIR && pnpm serve\n"
printf "  ${B}Update:${N}     curl -fsSL https://wentor.ai/install.sh | bash\n\n"
printf "  ${Y}NOTE:${N} The gateway log may show port ${D}28791${N} (browser automation).\n"
printf "        ${B}Ignore it${N} — your Dashboard is always at ${C}http://127.0.0.1:$PORT${N}\n\n"
printf "  ${B}Need help?${N} ${D}${ISSUES_URL}${N}\n\n"

if [ "${SKIP_START:-0}" = "1" ]; then
  exit 0
fi

# --- Check port availability ---
if command -v lsof &>/dev/null; then
  EXISTING_PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$EXISTING_PIDS" ]; then
    info "Port $PORT is in use. Stopping old instance..."
    echo "$EXISTING_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
  fi
fi

# --- Launch with auto-restart ---
# The gateway exits on SIGUSR1 after config save (API key, model, etc.),
# expecting an external supervisor to restart it. This loop handles that.
info "Starting gateway (auto-restart on config change)..."
printf "  ${D}Dashboard will open automatically at${N} ${C}http://127.0.0.1:$PORT${N}\n"
printf "  ${D}Press Ctrl+C to stop${N}\n\n"

# Open browser when ready (background)
(for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" &>/dev/null; then
    if [ "$RC_OS" = mac ]; then
      open "http://127.0.0.1:$PORT" 2>/dev/null || true
    else
      xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || true
    fi
    exit 0
  fi
  sleep 1
done) &

STOP=false
trap 'STOP=true' INT TERM
set +e

cd "$INSTALL_DIR"

# Use the same Node that the ABI rebuild targeted (conda openclaw → system fallback).
# This ensures better-sqlite3 ABI matches at runtime.
GW_NODE="${GW_NODE:-node}"
GW_NODE_DIR="$(dirname "$GW_NODE")"

# Always use project config — contains RC plugin paths, tool whitelist, dashboard root.
# install.sh already created config/openclaw.json from template at step [6/8].
export OPENCLAW_CONFIG_PATH=./config/openclaw.json

# Sync RC settings → ~/.openclaw/openclaw.json so `openclaw gateway --force` also works.
"$GW_NODE" scripts/sync-global-config.cjs 2>/dev/null || true

while true; do
  PATH="$GW_NODE_DIR:$PATH" \
    "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth none --port "$PORT" --force
  CODE=$?

  if $STOP; then
    printf "\n  ${G}Stopped.${N}\n"
    exit 0
  fi

  printf "  ${C}▸${N} Gateway exited (code $CODE) — restarting in 1s...\n"
  sleep 1
done
