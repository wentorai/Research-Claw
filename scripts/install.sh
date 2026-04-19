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
#   BIND         — gateway bind: "loopback" or "lan" (default: auto-detect SSH)
#   SKIP_START   — set to 1 to install only, don't launch gateway
#   NPM_REGISTRY — npm registry URL (for slow networks: https://registry.npmmirror.com)
# ============================================================================

# ── curl|bash safety ─────────────────────────────────────────────────────
# Wrap entire script in a function so bash reads it completely before executing.
# Without this, child processes (fnm installer, git, node) can read from stdin
# (the curl pipe), consuming script bytes and causing parse errors like:
#   bash: line 318: syntax error near unexpected token `fi'
# This is the standard pattern used by Homebrew, nvm, and rustup installers.
_main() {

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/research-claw}"
PORT="${PORT:-28789}"
# Default: Gitee (China mainland accessible). Fallback: GitHub.
# Override: REPO=https://github.com/wentorai/Research-Claw.git curl ... | bash
GITEE_REPO="https://gitee.com/Ruby_Callipygian_5cb5/ResearchClaw.git"
GITHUB_REPO="https://github.com/wentorai/Research-Claw.git"
REPO_OVERRIDE="${REPO:-}"
REPO="${REPO:-$GITEE_REPO}"
NODE_MIN=22
PNPM_VERSION=9
ISSUES_URL="https://github.com/wentorai/Research-Claw/issues"
RC_PNPM_PREFIX="${RC_PNPM_PREFIX:-$INSTALL_DIR/.tools/pnpm}"
PNPM_BIN=""
UPDATE_FAILED=false

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

ensure_ppt_master() {
  local target_dir="$INSTALL_DIR/ppt-master"
  local scripts_root="$target_dir/skills/ppt-master/scripts"

  if [ -f "$scripts_root/project_manager.py" ] && [ -f "$scripts_root/svg_to_pptx.py" ]; then
    ok "ppt-master ready"
    return 0
  fi

  if [ -f "$INSTALL_DIR/.gitmodules" ] && grep -q 'path = ppt-master' "$INSTALL_DIR/.gitmodules" 2>/dev/null; then
    info "Initializing ppt-master submodule..."
    git -C "$INSTALL_DIR" submodule sync -- ppt-master >/dev/null 2>&1 || true
    if ! git -C "$INSTALL_DIR" submodule update --init --recursive ppt-master; then
      die "Failed to initialize ppt-master. Try: cd $INSTALL_DIR && git submodule update --init --recursive ppt-master"
    fi
  fi

  if [ -f "$scripts_root/project_manager.py" ] && [ -f "$scripts_root/svg_to_pptx.py" ]; then
    ok "ppt-master ready"
    return 0
  fi

  die "ppt-master is missing required scripts after install. Try: cd $INSTALL_DIR && git submodule update --init --recursive ppt-master"
}

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

# --- SSH/headless detection: resolve bind mode early (used for config patch + output) ---
if [ -n "${BIND:-}" ]; then
  RC_BIND="$BIND"
elif [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ]; then
  RC_BIND="lan"
else
  RC_BIND=""
fi

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
      if bash "$tmp" --install-dir "$FNM_DIR" --skip-shell </dev/null &>/dev/null; then
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
  fnm install "$NODE_MIN" --progress=never </dev/null && fnm use "$NODE_MIN" </dev/null && fnm default "$NODE_MIN" </dev/null

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
  nvm install "$NODE_MIN" </dev/null && nvm use "$NODE_MIN" </dev/null && nvm alias default "$NODE_MIN" </dev/null
}

NODE_MAX=24  # Node 25+ is Current (not LTS); native modules (better-sqlite3) may not compile

ensure_node() {
  # Activate fnm/nvm if installed but not in PATH (curl|bash doesn't source .zshrc)
  if ! command -v node &>/dev/null; then
    # fnm: check known install location
    if [ -x "$HOME/.local/share/fnm/fnm" ]; then
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$("$HOME/.local/share/fnm/fnm" env --shell bash 2>/dev/null || true)"
    fi
    # nvm: source if present
    if ! command -v node &>/dev/null && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh"
    fi
  fi

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

activate_private_pnpm() {
  local bin_dir="$RC_PNPM_PREFIX/bin"
  if [ ! -x "$bin_dir/pnpm" ]; then
    return 1
  fi
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) export PATH="$bin_dir:$PATH" ;;
  esac
  return 0
}

pnpm_cmd_works() {
  command -v pnpm &>/dev/null || return 1
  pnpm --version &>/dev/null
}

install_private_pnpm() {
  mkdir -p "$RC_PNPM_PREFIX"
  info "Installing standalone pnpm $PNPM_VERSION..."
  npm install --prefix "$RC_PNPM_PREFIX" -g "pnpm@$PNPM_VERSION"
  activate_private_pnpm
}

ensure_pnpm() {
  if pnpm_cmd_works; then
    PNPM_BIN="$(command -v pnpm)"
    ok "pnpm $(pnpm --version)"
    return 0
  fi

  activate_private_pnpm || true
  if pnpm_cmd_works; then
    PNPM_BIN="$(command -v pnpm)"
    ok "pnpm $(pnpm --version)"
    return 0
  fi

  warn "Detected a broken pnpm/Corepack shim. Falling back to a standalone pnpm install."
  if ! install_private_pnpm || ! pnpm_cmd_works; then
    die "pnpm installation failed. Install manually: npm install --prefix $RC_PNPM_PREFIX -g pnpm@$PNPM_VERSION"
  fi

  PNPM_BIN="$(command -v pnpm)"
  ok "pnpm $(pnpm --version)"
}

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

  # --- Preserve user data files before git operations ---
  # L3 user-owned (SOUL, IDENTITY, TOOLS, USER) + L2 sentinel (BOOTSTRAP.md.done)
  # + workspace-level files are gitignored, but we backup for safety in case of
  # migration from older versions where they were still tracked.
  RC_DIR="workspace/.ResearchClaw"
  _RC_BAK="$(mktemp -d)"
  for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
    [ -f "$RC_DIR/$f" ] && cp "$RC_DIR/$f" "$_RC_BAK/$f"
  done
  [ -f "workspace/MEMORY.md" ] && cp "workspace/MEMORY.md" "$_RC_BAK/MEMORY.md"
  [ -f "workspace/USER.md" ] && cp "workspace/USER.md" "$_RC_BAK/WS_USER.md"
  [ -f "$RC_DIR/BOOTSTRAP.md.done" ] && cp "$RC_DIR/BOOTSTRAP.md.done" "$_RC_BAK/BOOTSTRAP.md.done"

  # Recover from interrupted rebase/merge (e.g. user Ctrl+C during update)
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git reset --hard HEAD 2>/dev/null || true
  # Remove untracked files that may conflict with incoming changes.
  # Gitignored files (config, data, node_modules, workspace runtime) are preserved.
  git clean -fd 2>/dev/null || true
  if ! (git pull --rebase --autostash 2>/dev/null || git pull); then
    warn "git pull failed. Possible causes:"
    warn "  - Network issue (try again later)"
    warn "  - VPN/proxy interference (try disabling VPN or switching to direct connection)"
    # --- Graceful fallback: start existing installation if runnable ---
    if [ -f "node_modules/openclaw/dist/entry.js" ]; then
      # Revert any partial changes from interrupted rebase/pull
      git rebase --abort 2>/dev/null || true
      git merge --abort 2>/dev/null || true
      git reset --hard HEAD 2>/dev/null || true
      printf "\n"
      warn "更新失败，请检查网络情况或联系开发人员 help@wentor.ai"
      warn "Update failed. Will start with existing local installation."
      printf "\n"
      UPDATE_FAILED=true
    else
      die "Update failed. No runnable installation found. Try: cd $INSTALL_DIR && git pull"
    fi
  fi

  # --- Restore user data files ---
  for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
    [ -f "$_RC_BAK/$f" ] && cp "$_RC_BAK/$f" "$RC_DIR/$f"
  done
  [ -f "$_RC_BAK/MEMORY.md" ] && cp "$_RC_BAK/MEMORY.md" "workspace/MEMORY.md"
  [ -f "$_RC_BAK/WS_USER.md" ] && cp "$_RC_BAK/WS_USER.md" "workspace/USER.md"
  [ -f "$_RC_BAK/BOOTSTRAP.md.done" ] && cp "$_RC_BAK/BOOTSTRAP.md.done" "$RC_DIR/BOOTSTRAP.md.done"
  rm -rf "$_RC_BAK"

  if ! $UPDATE_FAILED; then
    # Invalidate pnpm's "already up to date" cache after git pull.
    # Scenario: a previous pnpm install was aborted (e.g., "Proceed?" prompt got EOF)
    # but .modules.yaml was already written. Next run: pnpm sees hash match → skips
    # install → stale packages remain (e.g., sass-embedded instead of sass).
    # Deleting .modules.yaml forces pnpm to re-verify all packages against the lockfile.
    rm -f node_modules/.modules.yaml 2>/dev/null || true

    ok "Updated"
  fi
else
  info "Cloning to $INSTALL_DIR ..."
  if ! git clone --depth 1 "$REPO" "$INSTALL_DIR" 2>&1; then
    # If default Gitee failed and user didn't override REPO, try GitHub fallback
    if [ -z "${REPO_OVERRIDE:-}" ] && [ "$REPO" = "$GITEE_REPO" ]; then
      warn "Gitee clone failed — trying GitHub fallback..."
      if ! git clone --depth 1 "$GITHUB_REPO" "$INSTALL_DIR" 2>&1; then
        warn "Failed to clone from both Gitee and GitHub. Possible causes:"
        warn "  - Network issue (both Gitee and GitHub unreachable)"
        warn "  - VPN/proxy interference (try disabling VPN virtual adapter mode)"
        die "Clone failed. Check your network and try again."
      fi
    else
      warn "Failed to clone repository. Possible causes:"
      warn "  - Network issue (repository unreachable)"
      warn "  - VPN/proxy interference (try disabling VPN virtual adapter mode)"
      die "Clone failed. Check your network and try again."
    fi
  fi
  cd "$INSTALL_DIR"
  ok "Cloned"
fi

ensure_ppt_master

# --- Force git HTTPS (prevent SSH clone failures for git+ dependencies) ---
# @whiskeysockets/baileys references libsignal-node via git+https URL;
# some environments convert this to SSH (git@github.com:...) which fails
# without SSH keys. This env-level override forces HTTPS without modifying
# the user's global git config.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.https://github.com/.insteadOf"
export GIT_CONFIG_VALUE_0="git@github.com:"

# --- [5/8 cont.] pnpm ---
ensure_pnpm

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
#
# In curl|bash, stdin is the pipe (exhausted after bash reads the script).
# pnpm may prompt to recreate node_modules after lockfile changes, but reads
# EOF from stdin and defaults to "no" → ERR_PNPM_ABORTED_REMOVE_MODULES_DIR.
# Fix: pipe `yes` in non-interactive mode to auto-accept pnpm prompts.
_pnpm_install() {
  if [ -t 0 ]; then
    PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" install "$@"
  else
    # `echo y` sends a single "y\n" and exits 0 cleanly.
    # Using `yes` instead would cause SIGPIPE (exit 141) when pnpm closes stdin,
    # and `set -o pipefail` would treat the entire pipeline as failed.
    echo y | PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" install "$@"
  fi
}
if ! $UPDATE_FAILED; then
  info "Installing dependencies..."
  if ! (_pnpm_install --frozen-lockfile 2>/dev/null || _pnpm_install); then
    die "Dependency installation failed. Try: cd $INSTALL_DIR && pnpm install"
  fi
  ok "Dependencies installed"
fi

# --- Ensure `openclaw` CLI is in PATH ---
# The agent's system.run tool spawns a new shell that doesn't inherit
# node_modules/.bin. Create a wrapper script (NOT a symlink) at ~/.local/bin
# so `openclaw doctor`, `openclaw plugins list`, `openclaw channels add`,
# etc. work from any directory.
#
# Why not a symlink? pnpm's bin wrapper resolves paths relative to $0.
# On Linux, $0 for a symlink is the symlink path itself (not the target),
# so relative paths break: ~/.local/bin/../openclaw/openclaw.mjs → MODULE_NOT_FOUND.
# A wrapper that cd's into node_modules/.bin makes $0 = ./openclaw → paths resolve correctly.
OC_BIN_DIR="$INSTALL_DIR/node_modules/.bin"
if [ -x "$OC_BIN_DIR/openclaw" ]; then
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  # Remove stale symlink from previous installs (< v0.5.6)
  [ -L "$LOCAL_BIN/openclaw" ] && rm -f "$LOCAL_BIN/openclaw"
  cat > "$LOCAL_BIN/openclaw" << WRAPPER
#!/bin/sh
# Research-Claw — openclaw CLI wrapper (generated by install.sh)
# Do not edit; re-run install.sh to regenerate.
cd "${INSTALL_DIR}/node_modules/.bin" 2>/dev/null && exec ./openclaw "\$@"
echo "Error: Research-Claw not found at ${INSTALL_DIR}" >&2
echo "Reinstall: curl -fsSL https://wentor.ai/install.sh | bash" >&2
exit 1
WRAPPER
  chmod +x "$LOCAL_BIN/openclaw"
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) export PATH="$LOCAL_BIN:$PATH" ;;
  esac
  ok "openclaw CLI → $LOCAL_BIN/openclaw"
fi

if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    ok "Config created from template"
  fi
fi

# --- Migrate user settings from existing global OpenClaw config ---
# Runs on BOTH first install AND upgrade (catches v0.5.1–v0.5.3 users
# who already have a project config but lost their global settings).
#
# Heuristic: only migrates if project config has NO model configured
# but global config DOES. This prevents overwriting user's intentional
# changes while catching the "template without settings" case.
#
# Safety design:
#   - Whitelist-only: only known-safe fields are migrated
#   - Heuristic guard: only when project has no model but global does
#   - Backup: global config is never modified (read-only)
#   - Schema guard: migrated channels get commands.native=false (529 cmd limit)
#   - Validation: result is JSON-parsed back to catch corruption
#   - Failure-safe: any error → keep config as-is (2>/dev/null || true)
node -e "
  const fs = require('fs'), path = require('path');
  const globalPath = path.join(process.env.HOME || '', '.openclaw', 'openclaw.json');
  const projectPath = 'config/openclaw.json';
  if (!fs.existsSync(globalPath) || !fs.existsSync(projectPath)) process.exit(0);

  let g, p;
  try { g = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch { process.exit(0); }
  try { p = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch { process.exit(0); }

  // Heuristic: project config already has a model → user configured it, skip
  const pModel = p.agents?.defaults?.model;
  const hasProjectModel = pModel && (typeof pModel === 'string' ? pModel.trim() : pModel.primary?.trim());
  if (hasProjectModel) process.exit(0);

  // Global config has no model either → nothing to migrate
  const gModel = g.agents?.defaults?.model;
  const hasGlobalModel = gModel && (typeof gModel === 'string' ? gModel.trim() : gModel.primary?.trim());
  const hasGlobalProviders = g.models?.providers && Object.keys(g.models.providers).length > 0;
  const hasGlobalChannels = g.channels && Object.keys(g.channels).length > 0;
  const hasGlobalProxy = g.env && (g.env.HTTP_PROXY || g.env.HTTPS_PROXY);
  if (!hasGlobalModel && !hasGlobalProviders && !hasGlobalChannels && !hasGlobalProxy) process.exit(0);

  let migrated = false;

  // 1. models.providers — API keys, baseUrl, model definitions
  if (hasGlobalProviders) {
    if (!p.models) p.models = {};
    p.models.providers = g.models.providers;
    migrated = true;
  }

  // 2. agents.defaults.model + imageModel — current selected models
  const gDefaults = g.agents?.defaults;
  if (hasGlobalModel) {
    if (!p.agents) p.agents = {};
    if (!p.agents.defaults) p.agents.defaults = {};
    p.agents.defaults.model = gDefaults.model;
    if (gDefaults.imageModel) p.agents.defaults.imageModel = gDefaults.imageModel;
    migrated = true;
  }

  // 3. channels — feishu, telegram, etc. (with safety fix)
  if (hasGlobalChannels) {
    // Start from global channels, overlay any RC-template channel settings
    const merged = { ...g.channels };
    if (p.channels) {
      for (const [k, v] of Object.entries(p.channels)) merged[k] = v;
    }
    // Filter: only migrate channels that have valid credentials.
    // Channels with empty/missing tokens cause noisy auto-restart loops (10 retries each).
    const hasCredential = (name, ch) => {
      if (name === 'defaults' || typeof ch !== 'object' || ch === null) return true;
      const s = v => typeof v === 'string' && v.trim().length > 0 && !v.includes('<') && !v.includes('YOUR_');
      if (name === 'telegram') return s(ch.token) || s(ch.botToken);
      if (name === 'discord') return s(ch.token);
      if (name === 'feishu') {
        const accs = ch.accounts || {};
        return Object.values(accs).some(a => a && s(a.appId));
      }
      if (name === 'slack') return s(ch.token) || s(ch.appToken);
      return true; // whatsapp (QR), extensions, unknown — keep
    };
    for (const [name, ch] of Object.entries(merged)) {
      if (!hasCredential(name, ch)) { delete merged[name]; continue; }
      if (name === 'defaults' || typeof ch !== 'object' || ch === null) continue;
      // Safety: force commands.native=false on ALL channels
      // RC registers 529 commands, exceeding every IM platform's menu limit.
      if (!ch.commands) ch.commands = {};
      ch.commands.native = false;
    }
    if (Object.keys(merged).length > 0) {
      p.channels = merged;
      migrated = true;
    }
  }

  // 4. env — HTTP_PROXY, HTTPS_PROXY, custom vars
  if (hasGlobalProxy || (g.env?.vars && Object.keys(g.env.vars).length > 0)) {
    if (!p.env) p.env = {};
    if (g.env.HTTP_PROXY) p.env.HTTP_PROXY = g.env.HTTP_PROXY;
    if (g.env.HTTPS_PROXY) p.env.HTTPS_PROXY = g.env.HTTPS_PROXY;
    if (g.env.vars && Object.keys(g.env.vars).length > 0) {
      p.env.vars = { ...(p.env.vars || {}), ...g.env.vars };
    }
    migrated = true;
  }

  if (!migrated) process.exit(0);

  // Atomic write: temp file → validate → rename (survives disk-full)
  const output = JSON.stringify(p, null, 2) + '\n';
  try { JSON.parse(output); } catch { process.exit(1); }
  const tmp = projectPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, output);
  try { JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch { fs.unlinkSync(tmp); process.exit(1); }
  fs.renameSync(tmp, projectPath);

  // Report what was migrated
  const parts = [];
  if (hasGlobalProviders) parts.push('models');
  if (hasGlobalModel) parts.push('model');
  if (hasGlobalChannels) parts.push('channels');
  if (hasGlobalProxy) parts.push('proxy');
  console.log('  [config] Migrated from global: ' + parts.join(', '));
" 2>/dev/null || true

if [ -f config/openclaw.json ]; then
  node scripts/migrate-rc-data-dir.cjs 2>/dev/null || true
  # Clean stale references + ensure OC 2026.3.13+ required fields.
  # Shared logic in ensure-config.cjs — also called by run.sh and docker-entrypoint.sh.
  GLOBAL_CFG="$HOME/.openclaw/openclaw.json"
  node scripts/ensure-config.cjs config/openclaw.json ${GLOBAL_CFG:+"$GLOBAL_CFG"} 2>/dev/null || true
fi

# --- Patch gateway.bind for SSH/headless servers ---
# PVE CT, cloud VMs, etc. need LAN binding to access Dashboard from a browser.
# Auto-detects SSH sessions; explicit BIND env var always wins.
if [ -f config/openclaw.json ] && [ -n "${RC_BIND:-}" ]; then
  node -e "
    const fs = require('fs');
    const f = 'config/openclaw.json';
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!c.gateway) c.gateway = {};
    const target = process.argv[1];
    if (c.gateway.bind === target) process.exit(0);
    c.gateway.bind = target;
    const o = JSON.stringify(c, null, 2) + '\n';
    const t = f + '.tmp.' + process.pid;
    fs.writeFileSync(t, o);
    fs.renameSync(t, f);
  " "$RC_BIND" 2>/dev/null || true
  if [ -n "${BIND:-}" ]; then
    info "gateway.bind=$RC_BIND (explicit BIND env)"
  else
    info "gateway.bind=lan (SSH session detected — remote access enabled)"
  fi
fi

# --- Resolve Dashboard URL (LAN IP for remote access, 127.0.0.1 for local) ---
GATEWAY_BIND="$(node -e "try{const c=JSON.parse(require('fs').readFileSync('config/openclaw.json','utf8'));console.log(c.gateway?.bind||'loopback')}catch{console.log('loopback')}" 2>/dev/null || echo loopback)"
if [ "$GATEWAY_BIND" = "lan" ]; then
  if [ "$RC_OS" = mac ]; then
    DASHBOARD_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '0.0.0.0')"
  else
    DASHBOARD_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '0.0.0.0')"
  fi
else
  DASHBOARD_IP="127.0.0.1"
fi
DASHBOARD_URL="http://$DASHBOARD_IP:$PORT"

# --- Sync L1 bootstrap files to workspace root ---
# OC's heartbeat system reads workspace/HEARTBEAT.md directly (not .ResearchClaw/).
RC_DIR="workspace/.ResearchClaw"
for f in AGENTS.md HEARTBEAT.md; do
  [ -f "$RC_DIR/$f" ] && cp "$RC_DIR/$f" "workspace/$f"
done

# --- Initialize L2/L3 bootstrap runtime files from .example templates ---
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$RC_DIR/$f.example" ] && \
    cp "$RC_DIR/$f.example" "$RC_DIR/$f"
done
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md"
[ ! -f "workspace/USER.md" ] && [ -f "workspace/USER.md.example" ] && \
  cp "workspace/USER.md.example" "workspace/USER.md"
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md"

if ! $UPDATE_FAILED; then
  info "Building..."
  BUILD_LOG="$(mktemp)"
  if PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" build >"$BUILD_LOG" 2>&1; then
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
    PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" build:dashboard 2>&1 | tail -3 || true
    if [ ! -f "dashboard/dist/index.html" ]; then
      warn "Dashboard build failed. The gateway will start but the web UI may not load."
      warn "Try: cd $INSTALL_DIR && pnpm build:dashboard"
    else
      ok "Dashboard rebuilt"
    fi
  fi
fi

# --- [7/8] Ensure native modules work with gateway Node ---
# better-sqlite3 is a C++ addon. pnpm compiles it for whatever `node` is in PATH,
# but the gateway may run under a different Node (conda). Incremental repairs
# (rebuild, targeted rebuild) are unreliable when pnpm state is corrupted.
# Strategy: test require() → if fails, nuke node_modules and reinstall from scratch.

# Test better-sqlite3 from openclaw's pnpm virtual store context.
# pnpm doesn't hoist transitive deps — require('better-sqlite3') from CWD fails
# even when the module is correctly compiled. Resolve through openclaw's real path
# in the .pnpm store, where better-sqlite3 is a sibling in the same node_modules.
test_sqlite3() {
  "$GW_NODE" -e "
    const fs = require('fs'), path = require('path');
    const ocReal = fs.realpathSync('node_modules/openclaw');
    require(require.resolve('better-sqlite3', { paths: [path.join(ocReal, '..')] }));
  " 2>/dev/null
}

ensure_native_modules() {
  # Test: can the gateway Node actually load better-sqlite3?
  if test_sqlite3; then
    ok "Native modules OK"
    return 0
  fi

  # Attempt 1: targeted rebuild (fast, works for simple ABI mismatch)
  info "Native module ABI mismatch — rebuilding better-sqlite3..."
  PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" rebuild better-sqlite3 2>&1 | tail -3 || true
  if test_sqlite3; then
    ok "Native modules rebuilt for $("$GW_NODE" -v)"
    return 0
  fi

  # Attempt 2: clean reinstall (fixes corrupted pnpm store, interrupted installs)
  # Use $GW_NODE_DIR in PATH so native modules compile for the correct Node
  info "Rebuild failed — clean reinstalling dependencies..."
  rm -rf node_modules
  if ! (_pnpm_install --frozen-lockfile 2>/dev/null || _pnpm_install); then
    die "Dependency installation failed. Try: cd $INSTALL_DIR && pnpm install"
  fi
  # Rebuild dashboard after clean install
  PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" build 2>&1 | tail -3 || true

  if test_sqlite3; then
    ok "Native modules OK (clean install)"
    return 0
  fi

  # Attempt 3: conda/version mismatch — manually rebuild with gateway Node
  # MUST use $GW_NODE to run node-gyp directly. npx uses its own hardcoded Node
  # (system Homebrew), ignoring PATH — so it compiles for the wrong ABI.
  info "Compiling better-sqlite3 for $("$GW_NODE" -v)..."
  local SQLITE_PKG NODEGYP GW_NPM_ROOT
  SQLITE_PKG="$("$GW_NODE" -e "
    try {
      const fs = require('fs'), path = require('path');
      const ocReal = fs.realpathSync('node_modules/openclaw');
      const p = require.resolve('better-sqlite3/package.json', { paths: [path.join(ocReal, '..')] });
      console.log(p.replace(/\/package\.json$/, ''));
    } catch {}
  " 2>/dev/null)"
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

  if test_sqlite3; then
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

if ! $UPDATE_FAILED; then
  ensure_native_modules || true
else
  # Quick smoke test — warn if native modules are broken (no rebuild, just diagnostic)
  if ! test_sqlite3; then
    warn "Native module (better-sqlite3) may be corrupted. Gateway may fail to start."
    warn "Fix: cd $INSTALL_DIR && pnpm install && pnpm build"
  fi
fi

# --- [8/8] Register research-plugins (skills + agent tools) ---
# Installed via OpenClaw's plugin system (npm pack → ~/.openclaw/extensions/).
# NOT loaded from node_modules — avoids pnpm hardlink rejection.
# Use a minimal temp config for plugin install to avoid chicken-and-egg:
# the real config may reference research-plugins in plugins.allow before
# the plugin is actually installed, causing OC validation to reject the config.
# This matches the workaround used in Dockerfile.
run_openclaw_plugin_install() {
  local TMP_CFG; TMP_CFG="$(mktemp)"
  echo '{}' > "$TMP_CFG"
  local -a ENV_ARGS=("OPENCLAW_CONFIG_PATH=$TMP_CFG")
  [ -n "${NPM_REGISTRY:-}" ] && ENV_ARGS+=("npm_config_registry=$NPM_REGISTRY")
  local RC=0
  # Timeout (120s) prevents indefinite hang on slow npm networks (e.g. China)
  if command -v timeout &>/dev/null; then
    env "${ENV_ARGS[@]}" timeout 120 "$GW_NODE" ./node_modules/openclaw/dist/entry.js plugins install "$@" || RC=$?
  else
    env "${ENV_ARGS[@]}" "$GW_NODE" ./node_modules/openclaw/dist/entry.js plugins install "$@" || RC=$?
  fi
  rm -f "$TMP_CFG"
  return $RC
}
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
rp_summary() {
  local SKILLS; SKILLS=$(find "$PLUGIN_DIR/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  [ "$SKILLS" -gt 0 ] 2>/dev/null && echo "${SKILLS} skills" || true
}

if ! $UPDATE_FAILED; then

# Trap Ctrl+C during plugin install — exit cleanly instead of continuing to gateway
_RP_INTERRUPTED=false
trap '_RP_INTERRUPTED=true' INT

rp_network_hint() {
  warn "If npm is slow, use a China mirror:"
  printf "    ${C}NPM_REGISTRY=https://registry.npmmirror.com${N} curl -fsSL https://wentor.ai/install.sh | bash\n"
}

info "Installing research-plugins..."
if [ -d "$PLUGIN_DIR" ]; then
  # Update existing: backup → delete → install → restore on failure
  CURRENT_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
  cp -r "$PLUGIN_DIR" "${PLUGIN_DIR}.bak" 2>/dev/null || true
  rm -rf "$PLUGIN_DIR"
  RP_LOG="$(mktemp)"
  RP_EXIT=0
  run_openclaw_plugin_install @wentorai/research-plugins >"$RP_LOG" 2>&1 || RP_EXIT=$?
  if [ "$RP_EXIT" -eq 0 ]; then
    rm -rf "${PLUGIN_DIR}.bak"
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    if [ "$CURRENT_VER" = "$NEW_VER" ]; then
      RP_S=$(rp_summary); ok "Research-plugins v${NEW_VER}${RP_S:+ ($RP_S)}"
    else
      ok "Research-plugins updated: v${CURRENT_VER} → v${NEW_VER}"
    fi
  else
    # OC plugin installer failed — try fallback before restoring backup
    rm -rf "$PLUGIN_DIR"
    warn "OC plugin installer failed. Trying fallback method..."
    RP_FALLBACK_DIR="$(mktemp -d)"
    RP_FALLBACK_OK=false
    if npm pack @wentorai/research-plugins --pack-destination "$RP_FALLBACK_DIR" >>"$RP_LOG" 2>&1; then
      RP_TGZ=$(ls "$RP_FALLBACK_DIR"/wentorai-research-plugins-*.tgz 2>/dev/null | head -1)
      if [ -n "$RP_TGZ" ]; then
        mkdir -p "$PLUGIN_DIR"
        tar xzf "$RP_TGZ" --strip-components=1 -C "$PLUGIN_DIR" 2>>"$RP_LOG" && RP_FALLBACK_OK=true
      fi
    fi
    rm -rf "$RP_FALLBACK_DIR"

    if $RP_FALLBACK_OK; then
      rm -rf "${PLUGIN_DIR}.bak"
      NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
      ok "Research-plugins updated: v${CURRENT_VER} → v${NEW_VER} (fallback)"
    elif [ -d "${PLUGIN_DIR}.bak" ]; then
      rm -rf "$PLUGIN_DIR"
      mv "${PLUGIN_DIR}.bak" "$PLUGIN_DIR"
      warn "research-plugins update failed. Kept existing v${CURRENT_VER}."
      if [ "$RP_EXIT" -eq 124 ]; then
        warn "Download timed out (>120s)."
      else
        warn "Error details (last 5 lines):"
        tail -5 "$RP_LOG" 2>/dev/null | while IFS= read -r line; do printf "    %s\n" "$line"; done
      fi
      rp_network_hint
    else
      warn "research-plugins install failed. You can retry later:"
      printf "    cd $INSTALL_DIR && npx openclaw plugins install @wentorai/research-plugins\n"
      rp_network_hint
    fi
  fi
  rm -f "$RP_LOG"
else
  # Fresh install — clean any residual partial installs first
  rm -rf "$PLUGIN_DIR" 2>/dev/null || true
  RP_LOG="$(mktemp)"
  RP_EXIT=0
  run_openclaw_plugin_install @wentorai/research-plugins >"$RP_LOG" 2>&1 || RP_EXIT=$?
  if [ "$RP_EXIT" -eq 0 ]; then
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    RP_S=$(rp_summary); ok "Research-plugins v${NEW_VER}${RP_S:+ ($RP_S)}"
  else
    # Fallback: OC plugin installer may fail due to archive security checks.
    # Try manual npm pack + tar extract as a workaround.
    warn "OC plugin installer failed. Trying fallback method..."
    rm -rf "$PLUGIN_DIR" 2>/dev/null || true
    RP_FALLBACK_DIR="$(mktemp -d)"
    if npm pack @wentorai/research-plugins --pack-destination "$RP_FALLBACK_DIR" >"$RP_LOG" 2>&1; then
      RP_TGZ=$(ls "$RP_FALLBACK_DIR"/wentorai-research-plugins-*.tgz 2>/dev/null | head -1)
      if [ -n "$RP_TGZ" ]; then
        mkdir -p "$PLUGIN_DIR"
        tar xzf "$RP_TGZ" --strip-components=1 -C "$PLUGIN_DIR" 2>>"$RP_LOG" && RP_EXIT=0
      fi
    fi
    rm -rf "$RP_FALLBACK_DIR"

    if [ "$RP_EXIT" -eq 0 ]; then
      NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
      RP_S=$(rp_summary); ok "Research-plugins v${NEW_VER}${RP_S:+ ($RP_S)} (fallback)"
    else
      if [ "$RP_EXIT" -eq 124 ]; then
        warn "research-plugins download timed out (>120s)."
      else
        warn "research-plugins install failed."
        warn "Error details (last 5 lines):"
        tail -5 "$RP_LOG" 2>/dev/null | while IFS= read -r line; do printf "    %s\n" "$line"; done
      fi
      warn "You can retry later:"
      printf "    cd $INSTALL_DIR && npx openclaw plugins install @wentorai/research-plugins\n"
      rp_network_hint
    fi
  fi
  rm -f "$RP_LOG"
fi

# Restore default SIGINT handling
trap - INT
if $_RP_INTERRUPTED; then
  printf "\n"
  info "Interrupted. Research-plugins can be installed later:"
  printf "    cd $INSTALL_DIR && npx openclaw plugins install @wentorai/research-plugins\n"
  info "To start the gateway:"
  printf "    cd $INSTALL_DIR && bash scripts/run.sh\n"
  exit 130
fi

fi  # end: if ! $UPDATE_FAILED (skip build/install/plugins)

# --- Persist OPENCLAW_CONFIG_PATH in shell profile ---
# Ensures `openclaw config set/get` always targets the RC project config,
# not the vanilla ~/.openclaw/openclaw.json.
RC_ENV_LINE="export OPENCLAW_CONFIG_PATH=\"$INSTALL_DIR/config/openclaw.json\""
RC_ENV_MARKER="OPENCLAW_CONFIG_PATH"
RC_PROFILE_WRITTEN=false

for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$p" ]; then
    if grep -q "$RC_ENV_MARKER" "$p" 2>/dev/null; then
      # Already present — update in-place if path changed (idempotent upgrade)
      EXISTING_LINE="$(grep "$RC_ENV_MARKER" "$p" 2>/dev/null | head -1)"
      if [ "$EXISTING_LINE" != "$RC_ENV_LINE" ]; then
        # Path changed (user reinstalled to different dir) — update
        sed -i.bak "s|.*${RC_ENV_MARKER}.*|${RC_ENV_LINE}|" "$p" 2>/dev/null && rm -f "${p}.bak"
        info "Updated OPENCLAW_CONFIG_PATH in $p"
      fi
      RC_PROFILE_WRITTEN=true
      break
    fi
  fi
done

if ! $RC_PROFILE_WRITTEN; then
  # Not found in any existing profile — append to the user's shell rc
  RC_SHELL_RC="$HOME/.bashrc"
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh) RC_SHELL_RC="$HOME/.zshrc" ;;
  esac
  # Also check existing profiles one more time for files that exist but didn't match
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ]; then
      RC_SHELL_RC="$p"
      break
    fi
  done
  if printf '\n# Research-Claw config path (added by install.sh)\n%s\n' "$RC_ENV_LINE" >> "$RC_SHELL_RC" 2>/dev/null; then
    ok "OPENCLAW_CONFIG_PATH → $RC_SHELL_RC"
    RC_PROFILE_WRITTEN=true
  else
    warn "Could not write to $RC_SHELL_RC. Add manually:"
    warn "  $RC_ENV_LINE"
  fi
fi

# --- Persist standalone pnpm in shell profile (if installed) ---
# Without this, opening a new terminal and running `pnpm serve` would hit the
# broken Corepack shim again. Same pattern as fnm profile persistence.
if [ -x "$RC_PNPM_PREFIX/bin/pnpm" ]; then
  RC_PNPM_LINE="export PATH=\"$RC_PNPM_PREFIX/bin:\$PATH\""
  RC_PNPM_MARKER="$RC_PNPM_PREFIX/bin"
  RC_PNPM_WRITTEN=false
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ] && grep -q "$RC_PNPM_MARKER" "$p" 2>/dev/null; then
      RC_PNPM_WRITTEN=true
      break
    fi
  done
  if ! $RC_PNPM_WRITTEN; then
    # Find the profile that OPENCLAW_CONFIG_PATH was written to, or default
    RC_PNPM_RC="$HOME/.bashrc"
    case "$(basename "${SHELL:-/bin/bash}")" in zsh) RC_PNPM_RC="$HOME/.zshrc" ;; esac
    for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
      if [ -f "$p" ]; then RC_PNPM_RC="$p"; break; fi
    done
    printf '\n# Standalone pnpm (added by Research-Claw install.sh)\n%s\n' "$RC_PNPM_LINE" >> "$RC_PNPM_RC" 2>/dev/null || true
  fi
fi

# --- Persist ~/.local/bin in shell profile (for openclaw CLI) ---
LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ]; then
  LOCAL_BIN_MARKER='.local/bin'
  LOCAL_BIN_WRITTEN=false
  for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$p" ] && grep -q "$LOCAL_BIN_MARKER" "$p" 2>/dev/null; then
      LOCAL_BIN_WRITTEN=true
      break
    fi
  done
  if ! $LOCAL_BIN_WRITTEN; then
    RC_LB_RC="$HOME/.bashrc"
    case "$(basename "${SHELL:-/bin/bash}")" in zsh) RC_LB_RC="$HOME/.zshrc" ;; esac
    for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
      if [ -f "$p" ]; then RC_LB_RC="$p"; break; fi
    done
    printf '\n# ~/.local/bin (added by Research-Claw install.sh)\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC_LB_RC" 2>/dev/null || true
  fi
fi

# Apply to current session so the gateway startup below uses it
export OPENCLAW_CONFIG_PATH="$INSTALL_DIR/config/openclaw.json"

# --- Chrome/Chromium check (browser tool requires it) ---
if [ "$(uname)" = "Darwin" ]; then
  if ! [ -d "/Applications/Google Chrome.app" ] && ! [ -d "/Applications/Chromium.app" ]; then
    printf "\n  ${Y}NOTE:${N} Chrome/Chromium not found. The ${B}browser${N} tool will not work.\n"
    printf "        Install: ${C}https://www.google.com/chrome/${N}\n"
  fi
else
  if ! command -v google-chrome &>/dev/null && ! command -v chromium &>/dev/null && ! command -v chromium-browser &>/dev/null; then
    printf "\n  ${Y}NOTE:${N} Chrome/Chromium not found. The ${B}browser${N} tool will not work.\n"
    printf "        Install: ${C}https://www.google.com/chrome/${N}\n"
  fi
fi

# --- Done ---
printf "\n  ${G}${B}Ready!${N}\n\n"
printf "  ${B}Dashboard:${N}  ${C}${DASHBOARD_URL}${N}\n"
printf "  ${B}Location:${N}   $INSTALL_DIR\n"
printf "  ${B}Start:${N}      cd $INSTALL_DIR && bash scripts/run.sh\n"
if $UPDATE_FAILED; then
  printf "  ${Y}NOTE:${N}     Running with previous version (update failed).\n"
  printf "            Retry later: ${C}curl -fsSL https://wentor.ai/install.sh | bash${N}\n"
fi
if [ "$GATEWAY_BIND" = "lan" ]; then
  printf "  ${Y}NOTE:${N}     Gateway bound to LAN — accessible from other devices on your network.\n"
fi
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
printf "  ${D}Dashboard will open automatically at${N} ${C}${DASHBOARD_URL}${N}\n"
printf "  ${D}Press Ctrl+C to stop${N}\n\n"

# Open browser when ready (background)
# healthz always checks via loopback (works for both bind modes)
(for _ in $(seq 1 30); do
  if curl -sf --noproxy '*' "http://127.0.0.1:$PORT/healthz" &>/dev/null; then
    if [ "$RC_OS" = mac ]; then
      open "$DASHBOARD_URL" 2>/dev/null || true
    else
      xdg-open "$DASHBOARD_URL" 2>/dev/null || true
    fi
    exit 0
  fi
  sleep 1
done) &

STOP=false
trap 'STOP=true' INT TERM
trap - ERR  # Clear ERR trap — restart loop handles errors internally (macOS bash 3.2 compat)
set +e

cd "$INSTALL_DIR"

# GW_NODE and GW_NODE_DIR already resolved at [6/8] (conda openclaw → system fallback).

# OPENCLAW_CONFIG_PATH already exported at line 651 (shell profile section)
# using $INSTALL_DIR which is absolute ($HOME/research-claw by default).

# Resolve relative paths to absolute AND rebase stale absolute paths from other
# installations (e.g., dev ~/Downloads/wentor/research-claw → installed ~/research-claw).
# This happens when the config was written by run.sh in a different directory and
# survives across git pull (config is gitignored).
"$GW_NODE" -e "
const fs = require('fs'), path = require('path');
const f = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
const root = process.cwd();
const fix = p => {
  if (!path.isAbsolute(p)) return { v: path.resolve(root, p), c: true };
  if (p.startsWith(root + '/') || p === root) return { v: p, c: false };
  // Absolute path outside our root — try to rebase via basename match
  const name = path.basename(p);
  const parent = path.basename(path.dirname(p));
  const candidate = path.join(root, parent, name);
  try { fs.accessSync(candidate); return { v: candidate, c: true }; } catch {}
  return { v: p, c: false };
};
let changed = false;
if (cfg.plugins?.load?.paths) {
  cfg.plugins.load.paths = cfg.plugins.load.paths.map(p => { const r = fix(p); if (r.c) changed = true; return r.v; });
}
if (cfg.skills?.load?.extraDirs) {
  cfg.skills.load.extraDirs = cfg.skills.load.extraDirs.map(p => { const r = fix(p); if (r.c) changed = true; return r.v; });
}
if (cfg.gateway?.controlUi?.root) {
  const r = fix(cfg.gateway.controlUi.root); if (r.c) { cfg.gateway.controlUi.root = r.v; changed = true; }
}
if (cfg.agents?.defaults?.workspace) {
  const r = fix(cfg.agents.defaults.workspace); if (r.c) { cfg.agents.defaults.workspace = r.v; changed = true; }
}
if (cfg.plugins?.entries) {
  for (const e of Object.values(cfg.plugins.entries)) {
    if (e?.config?.dbPath && !path.isAbsolute(e.config.dbPath)) {
      if (e.config.dbPath.startsWith('~/')) {
        e.config.dbPath = path.join(require('os').homedir(), e.config.dbPath.slice(2)); changed = true;
      } else {
        e.config.dbPath = path.resolve(root, e.config.dbPath); changed = true;
      }
    }
  }
}
if (changed) { const o=JSON.stringify(cfg,null,2)+'\n',t=f+'.tmp.'+process.pid; fs.writeFileSync(t,o); fs.renameSync(t,f); console.log('[config] Rebased paths to ' + root); }
"

# Token auth — config file is the source of truth.
# Default 'research-claw' matches Dashboard's DEFAULT_TOKEN for zero-config local use.
# Custom token: set gateway.auth.token in config/openclaw.json.
# Env override: OPENCLAW_GATEWAY_TOKEN=my-secret curl ... | bash
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN=$("$GW_NODE" -e "
    try { const c = JSON.parse(require('fs').readFileSync('config/openclaw.json', 'utf8'));
      if (c.gateway?.auth?.token) console.log(c.gateway.auth.token);
    } catch {}
  " 2>/dev/null)
  export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-research-claw}"
fi

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

} # end _main — do not remove; curl|bash safety depends on this closing brace
_main "$@"
