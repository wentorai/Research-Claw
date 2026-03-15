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

# --- Linux package helper (supports apt, dnf, yum, pacman, apk) ---
pkg_install() {
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$@"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y -q "$@"
  elif command -v yum &>/dev/null; then
    sudo yum install -y -q "$@"
  elif command -v pacman &>/dev/null; then
    sudo pacman -Sy --noconfirm "$@"
  elif command -v apk &>/dev/null; then
    sudo apk add --no-cache "$@"
  else
    warn "No supported package manager found. Install manually: $*"
    return 1
  fi
}

# Map package names per distro (build tools for native modules)
build_pkg_names() {
  if command -v apt-get &>/dev/null; then
    echo "build-essential python3"
  elif command -v dnf &>/dev/null || command -v yum &>/dev/null; then
    echo "gcc-c++ make python3"
  elif command -v pacman &>/dev/null; then
    echo "base-devel python"
  elif command -v apk &>/dev/null; then
    echo "build-base python3"
  else
    echo "gcc g++ make python3"
  fi
}

# --- [2/8] Git ---
if ! command -v git &>/dev/null; then
  if [ "$RC_OS" = linux ]; then
    pkg_install git
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
    # Clean residual state that can block reinstallation
    sudo rm -rf /Library/Developer/CommandLineTools 2>/dev/null || true
    sudo xcode-select --reset 2>/dev/null || true
    # Method 1: softwareupdate (non-interactive, works in curl|bash, more reliable on macOS 26+)
    CLT_PKG="$(softwareupdate --list 2>&1 | awk -F': ' '/Command Line Tools for Xcode/{print $2; exit}' | xargs || true)"
    if [ -n "$CLT_PKG" ]; then
      info "Downloading $CLT_PKG (this may take a few minutes)..."
      softwareupdate --install "$CLT_PKG" --agree-to-license 2>&1 | tail -3 || true
    fi
    # Method 2: popup fallback (if softwareupdate didn't work)
    if ! xcode-select -p &>/dev/null; then
      xcode-select --install 2>/dev/null || true
      warn "Please complete Xcode CLT installation, then re-run this script."
      warn "If no popup appears, run manually:"
      warn "  softwareupdate --list   # find the package name"
      warn "  softwareupdate --install 'Command Line Tools for Xcode...' --agree-to-license"
      exit 1
    fi
    ok "Xcode CLT installed"
  fi
  # Python 3 is required by node-gyp for native module compilation
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found. Native module compilation may fail."
    warn "Install via: brew install python3  OR  xcode-select --install"
  fi
else
  # Linux: build tools + python3 + unzip (required by fnm installer) + curl
  NEED_PKGS=""
  if ! (command -v make &>/dev/null && command -v g++ &>/dev/null); then
    NEED_PKGS="$(build_pkg_names)"
  fi
  command -v unzip &>/dev/null || NEED_PKGS="$NEED_PKGS unzip"
  command -v curl &>/dev/null || NEED_PKGS="$NEED_PKGS curl"
  if [ -n "$NEED_PKGS" ]; then
    info "Installing system dependencies: $NEED_PKGS"
    # shellcheck disable=SC2086
    pkg_install $NEED_PKGS
  fi
fi

# --- [4/8] Node.js 22+ ---
# Supports nvm, fnm, and system Node. Prefers existing version manager.
install_node_fnm() {
  info "Installing Node.js $NODE_MIN via fnm..."
  if ! command -v fnm &>/dev/null; then
    local FNM_DIR="$HOME/.local/share/fnm"
    mkdir -p "$FNM_DIR"
    local INSTALLED=false

    # Method 1: installer script (requires Homebrew on macOS)
    local tmp; tmp="$(mktemp)"
    if curl -fsSL https://fnm.vercel.app/install -o "$tmp" 2>/dev/null; then
      if bash "$tmp" --install-dir "$FNM_DIR" --skip-shell &>/dev/null; then
        INSTALLED=true
      fi
    fi
    rm -f "$tmp"

    # Method 2: direct binary from GitHub (no Homebrew needed)
    if ! $INSTALLED; then
      info "Downloading fnm binary from GitHub..."
      # fnm-macos.zip = universal binary (x86_64 + arm64)
      # fnm-arm64.zip = Linux ARM64 (NOT macOS!)
      # fnm-linux.zip = Linux x86_64
      local FNM_ZIP="fnm-macos.zip"
      if [ "$RC_OS" = "linux" ]; then
        if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then
          FNM_ZIP="fnm-arm64.zip"
        else
          FNM_ZIP="fnm-linux.zip"
        fi
      fi
      local dl; dl="$(mktemp)"
      if curl -fsSL "https://github.com/Schniz/fnm/releases/latest/download/$FNM_ZIP" -o "$dl" 2>/dev/null; then
        unzip -o "$dl" -d "$FNM_DIR" &>/dev/null && chmod +x "$FNM_DIR/fnm" && INSTALLED=true
      fi
      rm -f "$dl"
    fi

    if ! $INSTALLED; then
      warn "Failed to install fnm. Install Node.js $NODE_MIN manually, then re-run:"
      if [ "$RC_OS" = mac ]; then
        warn "  brew install node@$NODE_MIN    # requires Homebrew: https://brew.sh"
      fi
      warn "Or set a proxy:  export HTTPS_PROXY=http://127.0.0.1:7890"
      return 1
    fi
    export PATH="$FNM_DIR:$PATH"
  fi
  eval "$(fnm env --shell bash 2>/dev/null || true)"
  fnm install "$NODE_MIN" --progress=never && fnm use "$NODE_MIN" && fnm default "$NODE_MIN"

  # Persist to shell profile (create if none exist)
  local FNM_SNIPPET
  FNM_SNIPPET="$(printf '\n# fnm (added by Research-Claw)\nexport PATH="$HOME/.local/share/fnm:$PATH"\neval "$(fnm env --use-on-cd --shell bash)"\n')"
  local PROFILE_WRITTEN=false
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ] && ! grep -q 'fnm env' "$p" 2>/dev/null; then
      if printf '%s' "$FNM_SNIPPET" >> "$p" 2>/dev/null; then
        PROFILE_WRITTEN=true
        break
      fi
    fi
  done
  if ! $PROFILE_WRITTEN; then
    # No existing profile or all read-only — try creating for the user's shell
    local SHELL_RC="$HOME/.bashrc"
    case "$(basename "${SHELL:-/bin/bash}")" in
      zsh) SHELL_RC="$HOME/.zshrc" ;;
    esac
    if ! printf '%s' "$FNM_SNIPPET" >> "$SHELL_RC" 2>/dev/null; then
      warn "Could not write to $SHELL_RC (permission denied). fnm works for this session"
      warn "but won't persist. Fix with: chmod u+w $SHELL_RC"
    else
      info "Created $SHELL_RC with fnm configuration"
    fi
  fi
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

NODE_MAX=24  # Node 25+ is Current (not LTS); native modules (better-sqlite3) may not compile

ensure_node() {
  # Check current Node version
  if command -v node &>/dev/null; then
    NODE_V="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$NODE_V" -ge "$NODE_MIN" ] 2>/dev/null; then
      if [ "$NODE_V" -gt "$NODE_MAX" ] 2>/dev/null; then
        warn "Node.js $(node -v) detected — native modules may not compile on Node $((NODE_MAX + 1))+."
        warn "If the gateway fails to start, downgrade to Node 22 LTS:"
        warn "  fnm install 22 && fnm use 22 && fnm default 22"
      fi
      ok "Node.js $(node -v)"
      return 0
    fi
  fi

  # Node missing or too old — try version managers in order
  # Use || true so failures fall through to the verification block below
  # (which shows actionable error messages instead of a cryptic ERR trap line number)
  # 1. nvm (if user already has it)
  if command -v nvm &>/dev/null || [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    install_node_nvm || true
  # 2. fnm (if user already has it, or install fresh)
  else
    install_node_fnm || true
  fi

  # Verify installation
  if ! command -v node &>/dev/null; then
    warn "Node.js installation failed. This is usually a network issue (fnm.vercel.app blocked)."
    warn "Install Node.js $NODE_MIN manually, then re-run this script:"
    if [ "$RC_OS" = mac ]; then
      warn "  brew install node@$NODE_MIN    # macOS (Homebrew)"
    else
      warn "  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN}.x | sudo -E bash -"
      warn "  sudo apt-get install -y nodejs"
    fi
    warn "Or set a proxy:  export HTTPS_PROXY=http://127.0.0.1:7890"
    die "Node.js $NODE_MIN+ is required but not found."
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
  npm install -g "pnpm@$PNPM_VERSION" &>/dev/null || true
fi
if ! command -v pnpm &>/dev/null; then
  die "pnpm installation failed. Install manually: npm install -g pnpm@$PNPM_VERSION"
fi
ok "pnpm $(pnpm -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# --- Disable Corepack strict mode ---
# Node 22+ enables Corepack by default. If a parent directory (e.g. ~/) has a
# package.json with "packageManager": "yarn@...", Corepack blocks pnpm with
# "This project is configured to use yarn" and causes "Invalid package.json".
export COREPACK_ENABLE_STRICT=0
export COREPACK_ENABLE_AUTO_PIN=0

# --- [5/8] Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  # Recover from interrupted rebase/merge (e.g. user Ctrl+C during update)
  # reset --hard is safe: user files are in workspace/ and config/ (both gitignored)
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git reset --hard HEAD 2>/dev/null || true
  if ! (git pull --rebase --autostash 2>/dev/null || git pull); then
    warn "git pull failed. Possible causes:"
    warn "  - Network issue (try again later)"
    warn "  - VPN/proxy interference (try disabling VPN or switching to direct connection)"
    die "Update failed. Try manually: cd $INSTALL_DIR && git pull"
  fi
  ok "Updated"
else
  info "Cloning to $INSTALL_DIR ..."
  if ! git clone --depth 1 "$REPO" "$INSTALL_DIR" 2>&1; then
    warn "Failed to clone repository. Possible causes:"
    warn "  - Network issue (GitHub unreachable)"
    warn "  - VPN/proxy interference (try disabling VPN virtual adapter mode)"
    warn "  - Firewall blocking GitHub"
    die "Clone failed. Check your network and try again."
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

# --- Detect gateway Node (early — needed for ABI rebuild, plugin install, gateway launch) ---
# OpenClaw re-execs under conda "openclaw" env's Node at runtime, regardless of which
# node launches entry.js. So we MUST compile native modules for that Node, not system node.
# Priority: 1) conda openclaw env Node  2) node next to openclaw binary  3) system node
GW_NODE="node"
if command -v conda &>/dev/null; then
  CONDA_OC_PREFIX="$(conda env list 2>/dev/null | grep "^openclaw " | awk '{print $NF}' || true)"
  if [ -n "$CONDA_OC_PREFIX" ] && [ -x "$CONDA_OC_PREFIX/bin/node" ]; then
    GW_NODE="$CONDA_OC_PREFIX/bin/node"
  fi
fi
if [ "$GW_NODE" = "node" ] && command -v openclaw &>/dev/null; then
  OC_PATH="$(command -v openclaw)"
  while [ -L "$OC_PATH" ]; do
    LINK_DIR="$(dirname "$OC_PATH")"
    OC_PATH="$(readlink "$OC_PATH")"
    case "$OC_PATH" in /*) ;; *) OC_PATH="$LINK_DIR/$OC_PATH" ;; esac
  done
  OC_DIR="$(dirname "$OC_PATH")"
  if [ -x "$OC_DIR/node" ]; then
    GW_NODE="$OC_DIR/node"
  fi
fi
# Resolve to absolute path so dirname works correctly for PATH injection
if [ "$GW_NODE" = "node" ]; then
  GW_NODE="$(command -v node)"
fi
GW_NODE_DIR="$(dirname "$GW_NODE")"
if [ "$GW_NODE" != "$(command -v node)" ]; then
  info "Gateway Node: $("$GW_NODE" -v) (conda openclaw)"
fi

# --- [6/8] Install + build ---
# Put $GW_NODE first in PATH so pnpm compiles native modules (better-sqlite3)
# for the gateway's Node, not the system Node. This avoids ABI mismatch entirely.
info "Installing dependencies..."
if ! (PATH="$GW_NODE_DIR:$PATH" pnpm install --frozen-lockfile 2>/dev/null || PATH="$GW_NODE_DIR:$PATH" pnpm install); then
  die "Dependency installation failed. Try: cd $INSTALL_DIR && pnpm install"
fi
ok "Dependencies installed"

if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    ok "Config created"
  fi
else
  # Clean stale references from older config versions (preserves user's API keys/model)
  # Cleans BOTH project config AND global config
  node -e "
    const fs = require('fs'), path = require('path');
    const files = ['config/openclaw.json'];
    const global_cfg = path.join(process.env.HOME || '', '.openclaw', 'openclaw.json');
    if (fs.existsSync(global_cfg)) files.push(global_cfg);
    let anyChanged = false;
    for (const f of files) {
      try {
        let c = JSON.parse(fs.readFileSync(f, 'utf8'));
        let changed = false;
        if (c.plugins?.load?.paths) {
          const before = c.plugins.load.paths.length;
          c.plugins.load.paths = c.plugins.load.paths.filter(p => !p.includes('node_modules'));
          if (c.plugins.load.paths.length !== before) changed = true;
        }
        if (c.plugins?.entries?.['wentor-connect']) {
          try { fs.accessSync('extensions/wentor-connect/dist'); }
          catch { delete c.plugins.entries['wentor-connect']; changed = true; }
        }
        // Ensure gateway auth token matches Dashboard DEFAULT_TOKEN
        // (previous openclaw setup may have written a different token)
        if (c.gateway?.auth) {
          if (c.gateway.auth.token && c.gateway.auth.token !== 'research-claw') {
            c.gateway.auth.token = 'research-claw';
            changed = true;
          }
          if (c.gateway.auth.mode && c.gateway.auth.mode !== 'none' && c.gateway.auth.mode !== 'token') {
            c.gateway.auth.mode = 'token';
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
          anyChanged = true;
        }
      } catch {}
    }
    if (anyChanged) console.log('  [config] Cleaned stale plugin references');
  " 2>/dev/null || true
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

# --- [7/8] Ensure native modules work with gateway Node ---
# better-sqlite3 is a C++ addon. pnpm compiles it for whatever `node` is in PATH,
# but the gateway may run under a different Node (conda). Incremental repairs
# (rebuild, targeted rebuild) are unreliable when pnpm state is corrupted.
# Strategy: test require() → if fails, nuke node_modules and reinstall from scratch.

ensure_native_modules() {
  # Test: can the gateway Node actually load better-sqlite3?
  if "$GW_NODE" -e "require('better-sqlite3')" 2>/dev/null; then
    ok "Native modules OK"
    return 0
  fi

  # Attempt 1: targeted rebuild (fast, works for simple ABI mismatch)
  info "Native module ABI mismatch — rebuilding better-sqlite3..."
  pnpm rebuild better-sqlite3 2>&1 | tail -3 || true
  if "$GW_NODE" -e "require('better-sqlite3')" 2>/dev/null; then
    ok "Native modules rebuilt for $("$GW_NODE" -v)"
    return 0
  fi

  # Attempt 2: clean reinstall (fixes corrupted pnpm store, interrupted installs)
  # Use $GW_NODE_DIR in PATH so native modules compile for the correct Node
  info "Rebuild failed — clean reinstalling dependencies..."
  rm -rf node_modules
  if ! (PATH="$GW_NODE_DIR:$PATH" pnpm install --frozen-lockfile 2>/dev/null || PATH="$GW_NODE_DIR:$PATH" pnpm install); then
    die "Dependency installation failed. Try: cd $INSTALL_DIR && pnpm install"
  fi
  # Rebuild dashboard after clean install
  pnpm build 2>&1 | tail -3 || true

  if "$GW_NODE" -e "require('better-sqlite3')" 2>/dev/null; then
    ok "Native modules OK (clean install)"
    return 0
  fi

  # Attempt 3: conda/version mismatch — manually rebuild with gateway Node
  # MUST use $GW_NODE to run node-gyp directly. npx uses its own hardcoded Node
  # (system Homebrew), ignoring PATH — so it compiles for the wrong ABI.
  info "Compiling better-sqlite3 for $("$GW_NODE" -v)..."
  local SQLITE_PKG NODEGYP GW_NPM_ROOT
  SQLITE_PKG="$("$GW_NODE" -e "try{console.log(require.resolve('better-sqlite3/package.json').replace(/\/package\.json$/,''))}catch{}" 2>/dev/null)"
  if [ -n "$SQLITE_PKG" ] && [ -f "$SQLITE_PKG/binding.gyp" ]; then
    # Find node-gyp bundled inside GW_NODE's npm installation
    GW_NPM_ROOT="$("$GW_NODE" -e "try{console.log(require('child_process').execSync('npm root -g',{env:{...process.env,PATH:'$GW_NODE_DIR:'+process.env.PATH}}).toString().trim())}catch{}" 2>/dev/null)"
    NODEGYP=""
    if [ -n "$GW_NPM_ROOT" ] && [ -f "$GW_NPM_ROOT/npm/node_modules/node-gyp/bin/node-gyp.js" ]; then
      NODEGYP="$GW_NPM_ROOT/npm/node_modules/node-gyp/bin/node-gyp.js"
    fi
    if [ -n "$NODEGYP" ]; then
      (cd "$SQLITE_PKG" && "$GW_NODE" "$NODEGYP" rebuild &>/dev/null) || true
    else
      # Last resort: npx with PATH override (may use wrong Node but worth trying)
      (cd "$SQLITE_PKG" && PATH="$GW_NODE_DIR:$PATH" npx --yes node-gyp rebuild &>/dev/null) || true
    fi
  fi

  if "$GW_NODE" -e "require('better-sqlite3')" 2>/dev/null; then
    ok "Native modules compiled for $("$GW_NODE" -v)"
    return 0
  fi

  warn "Native module compilation failed. The gateway may not start."
  if [ "$RC_OS" = mac ]; then
    warn "Ensure Xcode CLT is installed: xcode-select --install"
    warn "Ensure python3 is available: python3 --version"
  fi
  return 1
}

ensure_native_modules || true

# --- [8/8] Register research-plugins (skills + agent tools) ---
# Installed via OpenClaw's plugin system (npm pack → ~/.openclaw/extensions/).
# NOT loaded from node_modules — avoids pnpm hardlink rejection.
run_openclaw() { "$GW_NODE" ./node_modules/openclaw/dist/entry.js "$@"; }
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
info "Installing research-plugins..."
if [ -d "$PLUGIN_DIR" ]; then
  # Update existing: backup → delete → install → restore on failure
  CURRENT_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
  cp -r "$PLUGIN_DIR" "${PLUGIN_DIR}.bak" 2>/dev/null || true
  rm -rf "$PLUGIN_DIR"
  if run_openclaw plugins install @wentorai/research-plugins &>/dev/null; then
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
      printf "    cd $INSTALL_DIR && npx openclaw plugins install @wentorai/research-plugins\n"
    fi
  fi
else
  # Fresh install
  if run_openclaw plugins install @wentorai/research-plugins &>/dev/null; then
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    ok "Research-plugins v${NEW_VER} (431 skills, 13 tools)"
  else
    warn "research-plugins install failed (offline?). You can retry later:"
    printf "    cd $INSTALL_DIR && npx openclaw plugins install @wentorai/research-plugins\n"
  fi
fi

# --- Done ---
printf "\n  ${G}${B}Ready!${N}\n\n"
printf "  ${B}Dashboard:${N}  ${C}http://127.0.0.1:$PORT${N}\n"
printf "  ${B}Location:${N}   $INSTALL_DIR\n"
printf "  ${B}Start:${N}      cd $INSTALL_DIR && pnpm serve\n"
printf "  ${B}Plugins:${N}    cd $INSTALL_DIR && npx openclaw plugins install <name>\n"
printf "  ${B}Update:${N}     curl -fsSL https://wentor.ai/install.sh | bash\n\n"
printf "  ${Y}TIP:${N}  Use ${B}Chrome${N} for the best experience.\n"
printf "        Safari may have compatibility issues with the Dashboard.\n\n"
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

# GW_NODE and GW_NODE_DIR already resolved at [6/8] (conda openclaw → system fallback).

# Always use project config — contains RC plugin paths, tool whitelist, dashboard root.
# install.sh already created config/openclaw.json from template at step [6/8].
export OPENCLAW_CONFIG_PATH=./config/openclaw.json

# Token auth — matches Dashboard's DEFAULT_TOKEN ('research-claw').
# Using --auth token instead of --auth none: some environments with pre-existing
# OpenClaw device pairing state reject connections with NOT_PAIRED even when
# dangerouslyDisableDeviceAuth=true. Token auth bypasses device pairing entirely.
export OPENCLAW_GATEWAY_TOKEN=research-claw

# Sync RC settings → ~/.openclaw/openclaw.json so `openclaw gateway --force` also works.
"$GW_NODE" scripts/sync-global-config.cjs 2>/dev/null || true

CRASH_COUNT=0
MAX_CRASHES=10

while true; do
  START_TS=$(date +%s)

  PATH="$GW_NODE_DIR:$PATH" \
    "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port "$PORT" --force \
    </dev/null
  CODE=$?

  if $STOP; then
    printf "\n  ${G}Stopped.${N}\n"
    exit 0
  fi

  # If gateway ran > 30s, it was a normal config-change restart — reset crash counter
  ELAPSED=$(( $(date +%s) - START_TS ))
  if [ "$ELAPSED" -gt 30 ]; then
    CRASH_COUNT=0
  else
    CRASH_COUNT=$((CRASH_COUNT + 1))
  fi

  if [ "$CRASH_COUNT" -ge "$MAX_CRASHES" ]; then
    printf "\n  ${R}  ✗ Gateway crashed %s times in quick succession. Stopping.${N}\n" "$MAX_CRASHES"
    printf "  ${D}Check logs above for errors. Report: ${ISSUES_URL}${N}\n"
    exit 1
  fi

  # Backoff: 1s, 2s, 3s, 4s, 5s (cap)
  BACKOFF=$((CRASH_COUNT > 5 ? 5 : (CRASH_COUNT > 0 ? CRASH_COUNT : 1)))
  printf "  ${C}▸${N} Gateway exited (code $CODE) — restarting in ${BACKOFF}s...\n"
  sleep "$BACKOFF"
done
