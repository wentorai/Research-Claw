#!/usr/bin/env bash
# ============================================================================
# Research-Claw (科研龙虾) — Install / Update / Start
# Hosted at: https://wentor.ai/install.sh
#
# Usage:
#   curl -fsSL https://wentor.ai/install.sh | bash
#
# Platforms: macOS, Linux, and WSL2 (run inside the Linux distribution).
# Native Windows users should use scripts/install-docker.ps1 with Docker Desktop.
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
PPT_MASTER_GITHUB="https://github.com/hugohe3/ppt-master.git"
PPT_MASTER_ATOMGIT="https://atomgit.com/hugohe3/ppt-master.git"
REPO_OVERRIDE="${REPO:-}"
REPO="${REPO:-$GITEE_REPO}"
NODE_MIN=22
NODE_MAX=22
PNPM_VERSION=10.34.4
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
die()  {
  printf "${R}  ✗ %s${N}\n" "$1" >&2
  [ -n "${RC_LOG:-}" ] && [ -s "${RC_LOG:-}" ] && printf "  ${D}Diagnostic log (attach to bug reports): ${RC_LOG}${N}\n" >&2
  printf "  ${D}Report: ${ISSUES_URL}${N}\n" >&2
  exit 1
}

# ── Optional Bootstrap Profile capsule (0.8.3) ─────────────────────────
# The Token exists only in this installer process and a private curl config.
# It is never exported, logged, passed to Node, or written under INSTALL_DIR.
RC_BOOTSTRAP_REDEEM_URL="https://wentor.ai/api/v1/rc/bootstrap/redeem"
RC_PROFILE_AUTH_TOKEN=""
RC_PROFILE_TEMP_PARENT=""
RC_PROFILE_TEMP_ROOT=""
RC_PROFILE_CURL_CONFIG=""
RC_PROFILE_HEADERS=""
RC_PROFILE_CAPSULE=""
RC_PROFILE_TX_ID=""
RC_PROFILE_PENDING_STATE=""
RC_PROFILE_COMMITTED=false
RC_PROFILE_COMMIT_ATTEMPTED=false

# ── Installer lifecycle cleanup ────────────────────────────────────────
# Update snapshots and heartbeat logs may contain user data or subprocess
# output. Keep their identities frozen so EXIT never follows a swapped path.
RC_INSTALL_CLEANUP_RUNNING=false
RC_INSTALL_TEMP_PARENT=""
RC_INSTALL_TEMP_PARENT_ID=""
RC_HEARTBEAT_PID=""
RC_HEARTBEAT_LOG=""
RC_HEARTBEAT_LOG_ID=""
RC_UPDATE_INSTALL_ROOT=""
RC_UPDATE_INSTALL_ROOT_ID=""
RC_UPDATE_BACKUP_ROOT=""
RC_UPDATE_BACKUP_ROOT_ID=""
RC_UPDATE_BACKUP_READY=false
RC_UPDATE_MUTATION_STARTED=false

rc_install_path_identity() {
  local _value
  if _value="$(stat -f '%d:%i' "$1" 2>/dev/null)"; then
    printf '%s\n' "$_value"
    return 0
  fi
  stat -c '%d:%i' "$1" 2>/dev/null
}

rc_install_path_owner() {
  local _value
  if _value="$(stat -f '%u' "$1" 2>/dev/null)"; then
    printf '%s\n' "$_value"
    return 0
  fi
  stat -c '%u' "$1" 2>/dev/null
}

rc_install_path_mode() {
  local _value
  if _value="$(stat -f '%Lp' "$1" 2>/dev/null)"; then
    printf '%s\n' "$_value"
    return 0
  fi
  stat -c '%a' "$1" 2>/dev/null
}

rc_install_init_temp_parent() {
  if [ -n "$RC_INSTALL_TEMP_PARENT" ]; then
    [ -d "$RC_INSTALL_TEMP_PARENT" ] && [ ! -L "$RC_INSTALL_TEMP_PARENT" ] \
      && [ "$(rc_install_path_identity "$RC_INSTALL_TEMP_PARENT")" = "$RC_INSTALL_TEMP_PARENT_ID" ] \
      || return 1
    return 0
  fi
  RC_INSTALL_TEMP_PARENT="$(cd -P -- "${TMPDIR:-/tmp}" && pwd -P)" || return 1
  [ -d "$RC_INSTALL_TEMP_PARENT" ] && [ ! -L "$RC_INSTALL_TEMP_PARENT" ] || return 1
  RC_INSTALL_TEMP_PARENT_ID="$(rc_install_path_identity "$RC_INSTALL_TEMP_PARENT")" \
    || return 1
  [ -n "$RC_INSTALL_TEMP_PARENT_ID" ]
}

rc_install_validate_private_child() {
  local _path="$1" _identity="$2" _prefix="$3" _kind="$4"
  local _name
  rc_install_init_temp_parent || return 1
  [ -n "$_path" ] && [ ! -L "$_path" ] || return 1
  [ "$(dirname "$_path")" = "$RC_INSTALL_TEMP_PARENT" ] || return 1
  _name="$(basename "$_path")"
  case "$_name" in "${_prefix}"*) ;; *) return 1 ;; esac
  case "$_kind" in
    directory) [ -d "$_path" ] ;;
    file) [ -f "$_path" ] ;;
    *) return 1 ;;
  esac || return 1
  [ "$(rc_install_path_owner "$_path")" = "$(id -u)" ] || return 1
  [ "$(rc_install_path_identity "$_path")" = "$_identity" ] || return 1
  case "$_kind" in
    directory) [ "$(rc_install_path_mode "$_path")" = 700 ] ;;
    file) [ "$(rc_install_path_mode "$_path")" = 600 ] ;;
  esac
}

rc_install_remove_heartbeat_log() {
  [ -n "$RC_HEARTBEAT_LOG" ] || return 0
  rc_install_validate_private_child \
    "$RC_HEARTBEAT_LOG" "$RC_HEARTBEAT_LOG_ID" rc-install-heartbeat. file \
    || return 1
  rm -f -- "$RC_HEARTBEAT_LOG" || return 1
  [ ! -e "$RC_HEARTBEAT_LOG" ] && [ ! -L "$RC_HEARTBEAT_LOG" ] || return 1
  RC_HEARTBEAT_LOG=""
  RC_HEARTBEAT_LOG_ID=""
}

rc_install_cleanup_heartbeat() {
  local _pid="${RC_HEARTBEAT_PID:-}" _ppid="" _failed=0 _attempt
  if [ -n "$_pid" ]; then
    case "$_pid" in *[!0-9]*|'') _failed=1 ;;
      *)
        if kill -0 "$_pid" 2>/dev/null; then
          _ppid="$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d '[:space:]')"
          if [ "$_ppid" = "$$" ]; then
            kill -TERM "$_pid" 2>/dev/null || true
            _attempt=0
            while kill -0 "$_pid" 2>/dev/null && [ "$_attempt" -lt 20 ]; do
              sleep 0.1
              _attempt=$((_attempt + 1))
            done
            if kill -0 "$_pid" 2>/dev/null; then
              kill -KILL "$_pid" 2>/dev/null || true
            fi
          else
            _failed=1
          fi
        fi
        wait "$_pid" 2>/dev/null || true
        ;;
    esac
    RC_HEARTBEAT_PID=""
  fi
  rc_install_remove_heartbeat_log || _failed=1
  [ "$_failed" -eq 0 ]
}

rc_install_validate_update_root() {
  [ -n "$RC_UPDATE_INSTALL_ROOT" ] \
    && [ -d "$RC_UPDATE_INSTALL_ROOT" ] \
    && [ ! -L "$RC_UPDATE_INSTALL_ROOT" ] \
    && [ "$(cd -P -- "$RC_UPDATE_INSTALL_ROOT" && pwd -P)" = "$RC_UPDATE_INSTALL_ROOT" ] \
    && [ "$(rc_install_path_identity "$RC_UPDATE_INSTALL_ROOT")" = "$RC_UPDATE_INSTALL_ROOT_ID" ]
}

rc_install_validate_update_backup() {
  rc_install_validate_private_child \
    "$RC_UPDATE_BACKUP_ROOT" "$RC_UPDATE_BACKUP_ROOT_ID" rc-install-user-backup. directory
}

rc_install_snapshot_update_item() {
  local _key="$1" _relative="$2"
  local _source="$RC_UPDATE_INSTALL_ROOT/$_relative"
  local _copy="$RC_UPDATE_BACKUP_ROOT/$_key.value"
  local _type="$RC_UPDATE_BACKUP_ROOT/$_key.type"
  if [ -L "$_source" ]; then
    printf 'symlink\n' > "$_type" || return 1
    cp -P "$_source" "$_copy" || return 1
    [ -L "$_copy" ] || return 1
  elif [ -f "$_source" ]; then
    printf 'regular\n' > "$_type" || return 1
    cp -p "$_source" "$_copy" || return 1
    [ -f "$_copy" ] && [ ! -L "$_copy" ] || return 1
  elif [ ! -e "$_source" ]; then
    printf 'absent\n' > "$_type" || return 1
  else
    return 1
  fi
  chmod 600 "$_type" || return 1
}

rc_install_snapshot_update_backup() {
  local _old_umask _root
  [ -z "$RC_UPDATE_BACKUP_ROOT" ] || return 1
  rc_install_init_temp_parent || return 1
  RC_UPDATE_INSTALL_ROOT="$(cd -P -- "$INSTALL_DIR" && pwd -P)" || return 1
  RC_UPDATE_INSTALL_ROOT_ID="$(rc_install_path_identity "$RC_UPDATE_INSTALL_ROOT")" \
    || return 1
  _old_umask="$(umask)"
  umask 077
  if ! _root="$(mktemp -d "$RC_INSTALL_TEMP_PARENT/rc-install-user-backup.XXXXXX")"; then
    umask "$_old_umask"
    return 1
  fi
  umask "$_old_umask"
  RC_UPDATE_BACKUP_ROOT="$_root"
  chmod 700 "$RC_UPDATE_BACKUP_ROOT" || return 1
  RC_UPDATE_BACKUP_ROOT_ID="$(rc_install_path_identity "$RC_UPDATE_BACKUP_ROOT")" \
    || return 1
  rc_install_validate_update_backup || return 1
  rc_install_snapshot_update_item soul workspace/.ResearchClaw/SOUL.md \
    && rc_install_snapshot_update_item identity workspace/.ResearchClaw/IDENTITY.md \
    && rc_install_snapshot_update_item tools workspace/.ResearchClaw/TOOLS.md \
    && rc_install_snapshot_update_item rc-user workspace/.ResearchClaw/USER.md \
    && rc_install_snapshot_update_item memory workspace/MEMORY.md \
    && rc_install_snapshot_update_item workspace-user workspace/USER.md \
    && rc_install_snapshot_update_item bootstrap-done workspace/.ResearchClaw/BOOTSTRAP.md.done \
    || return 1
  RC_UPDATE_BACKUP_READY=true
}

rc_install_prepare_restore_parent() {
  local _relative="$1" _parent
  rc_install_validate_update_root || return 1
  case "$_relative" in
    workspace) ;;
    workspace/.ResearchClaw)
      rc_install_prepare_restore_parent workspace || return 1
      ;;
    *) return 1 ;;
  esac
  _parent="$RC_UPDATE_INSTALL_ROOT/$_relative"
  [ ! -L "$_parent" ] || return 1
  if [ ! -e "$_parent" ]; then mkdir "$_parent" || return 1; fi
  [ -d "$_parent" ] && [ ! -L "$_parent" ] || return 1
  [ "$(cd -P -- "$_parent" && pwd -P)" = "$_parent" ]
}

rc_install_restore_update_item() {
  local _key="$1" _relative="$2" _parent_relative="$3"
  local _type_file="$RC_UPDATE_BACKUP_ROOT/$_key.type"
  local _copy="$RC_UPDATE_BACKUP_ROOT/$_key.value"
  local _destination="$RC_UPDATE_INSTALL_ROOT/$_relative"
  local _parent="$RC_UPDATE_INSTALL_ROOT/$_parent_relative" _type _temp
  rc_install_validate_update_backup && rc_install_prepare_restore_parent "$_parent_relative" \
    || return 1
  [ -f "$_type_file" ] && [ ! -L "$_type_file" ] || return 1
  _type="$(cat "$_type_file")" || return 1
  if [ -e "$_destination" ] && [ ! -f "$_destination" ] && [ ! -L "$_destination" ]; then
    return 1
  fi
  case "$_type" in
    absent)
      if [ -e "$_destination" ] || [ -L "$_destination" ]; then
        rm -f -- "$_destination" || return 1
      fi
      ;;
    regular)
      [ -f "$_copy" ] && [ ! -L "$_copy" ] || return 1
      _temp="$(mktemp "$_parent/.rc-install-restore.XXXXXX")" || return 1
      if ! cp -p "$_copy" "$_temp" || ! mv -f "$_temp" "$_destination"; then
        rm -f -- "$_temp" 2>/dev/null || true
        return 1
      fi
      ;;
    symlink)
      [ -L "$_copy" ] || return 1
      _temp="$(mktemp "$_parent/.rc-install-restore.XXXXXX")" || return 1
      rm -f -- "$_temp" || return 1
      if ! cp -P "$_copy" "$_temp" || [ ! -L "$_temp" ] \
          || ! mv -f "$_temp" "$_destination"; then
        rm -f -- "$_temp" 2>/dev/null || true
        return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

rc_install_restore_update_backup() {
  [ "$RC_UPDATE_BACKUP_READY" = true ] || return 1
  [ "$RC_UPDATE_MUTATION_STARTED" = true ] || return 0
  rc_install_restore_update_item soul workspace/.ResearchClaw/SOUL.md workspace/.ResearchClaw \
    && rc_install_restore_update_item identity workspace/.ResearchClaw/IDENTITY.md workspace/.ResearchClaw \
    && rc_install_restore_update_item tools workspace/.ResearchClaw/TOOLS.md workspace/.ResearchClaw \
    && rc_install_restore_update_item rc-user workspace/.ResearchClaw/USER.md workspace/.ResearchClaw \
    && rc_install_restore_update_item memory workspace/MEMORY.md workspace \
    && rc_install_restore_update_item workspace-user workspace/USER.md workspace \
    && rc_install_restore_update_item bootstrap-done workspace/.ResearchClaw/BOOTSTRAP.md.done workspace/.ResearchClaw \
    || return 1
  RC_UPDATE_MUTATION_STARTED=false
}

rc_install_discard_update_backup() {
  [ -n "$RC_UPDATE_BACKUP_ROOT" ] || return 0
  [ "$RC_UPDATE_MUTATION_STARTED" != true ] || return 1
  rc_install_validate_update_backup || return 1
  rm -rf -- "$RC_UPDATE_BACKUP_ROOT" || return 1
  [ ! -e "$RC_UPDATE_BACKUP_ROOT" ] && [ ! -L "$RC_UPDATE_BACKUP_ROOT" ] || return 1
  RC_UPDATE_BACKUP_ROOT=""
  RC_UPDATE_BACKUP_ROOT_ID=""
  RC_UPDATE_BACKUP_READY=false
  RC_UPDATE_INSTALL_ROOT=""
  RC_UPDATE_INSTALL_ROOT_ID=""
}

rc_profile_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --auth-token)
        [ -z "$RC_PROFILE_AUTH_TOKEN" ] || die "--auth-token may be provided only once."
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "--auth-token requires a non-empty value."
        [[ "$2" =~ ^rca_[A-Za-z0-9_-]{43,}$ ]] \
          || die "--auth-token has an invalid format."
        RC_PROFILE_AUTH_TOKEN="$2"
        shift 2
        ;;
      *) die "Unknown installer argument: $1" ;;
    esac
  done
}

rc_profile_cleanup_host_secret() {
  [ -n "$RC_PROFILE_TEMP_ROOT" ] || return 0
  local _parent _name
  _parent="$(dirname "$RC_PROFILE_TEMP_ROOT")"
  _name="$(basename "$RC_PROFILE_TEMP_ROOT")"
  [ -n "$RC_PROFILE_TEMP_PARENT" ] \
    && [ "$_parent" = "$RC_PROFILE_TEMP_PARENT" ] \
    && [[ "$_name" == rc-bootstrap-installer.* ]] \
    || return 1
  rm -rf -- "$RC_PROFILE_TEMP_ROOT" || return 1
  [ ! -e "$RC_PROFILE_TEMP_ROOT" ] || return 1
  RC_PROFILE_TEMP_PARENT=""
  RC_PROFILE_TEMP_ROOT=""
  RC_PROFILE_CURL_CONFIG=""
  RC_PROFILE_HEADERS=""
  RC_PROFILE_CAPSULE=""
}

rc_profile_validate_redeem_response() {
  local _declared _actual
  _declared="$(awk '
    function reset_headers() {
      content_type = ""; content_encoding = ""; content_length = ""
      content_type_count = 0; content_encoding_count = 0; content_length_count = 0
      transfer_encoding_count = 0
    }
    BEGIN { saw_status = 0; in_headers = 0; reset_headers() }
    {
      line = $0
      sub(/\r$/, "", line)
      lower = tolower(line)
      if (lower ~ /^http\/[0-9.]+ [0-9][0-9][0-9]/) {
        saw_status = 1
        split(lower, status_fields, /[ \t]+/)
        status_code = status_fields[2]
        reset_headers()
        in_headers = 1
        next
      }
      if (!in_headers) next
      if (line == "") { in_headers = 0; next }
      separator = index(line, ":")
      if (separator < 1) next
      name = tolower(substr(line, 1, separator - 1))
      value = substr(line, separator + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      if (name == "content-type") {
        content_type = tolower(value); content_type_count++
      } else if (name == "content-encoding") {
        content_encoding = tolower(value); content_encoding_count++
      } else if (name == "content-length") {
        content_length = value; content_length_count++
      } else if (name == "transfer-encoding") {
        transfer_encoding_count++
      }
    }
    END {
      if (!saw_status || status_code != "200" ||
          content_type_count != 1 || content_encoding_count != 1 ||
          content_length_count != 1 || transfer_encoding_count != 0 ||
          content_type != "application/json; charset=utf-8" ||
          content_encoding != "identity" ||
          content_length !~ /^(0|[1-9][0-9]*)$/ ||
          content_length + 0 > 2097152) exit 1
      print content_length
    }
  ' "$RC_PROFILE_HEADERS")" || return 1
  _actual="$(wc -c < "$RC_PROFILE_CAPSULE" | tr -d '[:space:]')"
  [ -n "$_actual" ] && [ "$_actual" -gt 0 ] \
    && [ "$_actual" -le 2097152 ] && [ "$_actual" = "$_declared" ]
}

rc_profile_native_cli() {
  "$GW_NODE" "$INSTALL_DIR/scripts/apply-bootstrap-profile.cjs" "$1" \
    --rc-root "$INSTALL_DIR" \
    --config "$INSTALL_DIR/config/openclaw.json" \
    --workspace "$INSTALL_DIR/workspace" \
    --state-dir "$HOME/.openclaw" \
    --db "$HOME/.research-claw/library.db" \
    --global-config "$HOME/.openclaw/openclaw.json" \
    "${@:2}"
}

rc_profile_rollback_native() {
  local _result _state
  [ -n "$RC_PROFILE_TX_ID" ] || return 0
  if ! _result="$(rc_profile_native_cli rollback --tx-id "$RC_PROFILE_TX_ID")"; then
    return 1
  fi
  _state="$(printf '%s' "$_result" | "$GW_NODE" -e '
    let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
      const state=JSON.parse(raw).state;
      if (state !== "rolled-back" && state !== "committed") process.exit(1);
      process.stdout.write(state);
    });
  ')" || return 1
  [ "$_state" != committed ] || RC_PROFILE_COMMITTED=true
  RC_PROFILE_TX_ID=""
  RC_PROFILE_PENDING_STATE=""
}

rc_profile_load_pending_native() {
  local _status _parsed
  if ! _status="$(rc_profile_native_cli status)"; then
    return 1
  fi
  _parsed="$(printf '%s' "$_status" | "$GW_NODE" -e '
    let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
      const pending=JSON.parse(raw).pendingTransaction;
      if (pending === null) return;
      if (!/^tx-[0-9a-f-]{36}$/.test(pending?.txId || "")
          || !/^[a-z]+$/.test(pending?.state || "")) process.exit(1);
      process.stdout.write(`${pending.txId} ${pending.state}`);
    });
  ')" || return 1
  if [ -n "$_parsed" ]; then
    read -r RC_PROFILE_TX_ID RC_PROFILE_PENDING_STATE <<EOF
$_parsed
EOF
  else
    RC_PROFILE_TX_ID=""
    RC_PROFILE_PENDING_STATE=""
  fi
}

rc_profile_cleanup_on_exit() {
  local _failed=0
  if [ -n "$RC_PROFILE_TX_ID" ] && [ "$RC_PROFILE_COMMITTED" != true ] \
      && [ -x "${GW_NODE:-}" ] && [ -f "$INSTALL_DIR/scripts/apply-bootstrap-profile.cjs" ]; then
    if [ "$RC_PROFILE_COMMIT_ATTEMPTED" != true ] || rc_profile_load_pending_native; then
      rc_profile_rollback_native >/dev/null 2>&1 || true
    fi
  fi
  if ! rc_profile_cleanup_host_secret; then
    printf '  ✗ Could not remove Bootstrap Profile private files.\n' >&2
    _failed=1
  fi
  [ "$_failed" -eq 0 ]
}

# Compatibility entry point used by the focused Profile harnesses. Production
# installs use rc_install_exit_cleanup as the one EXIT orchestrator.
rc_profile_exit_cleanup() {
  local _status=$? _cleanup_status=0
  trap - EXIT ERR
  trap '' INT TERM
  set +e
  rc_profile_cleanup_on_exit || _cleanup_status=1
  if [ "$_status" -eq 0 ] && [ "$_cleanup_status" -ne 0 ]; then _status=1; fi
  exit "$_status"
}

rc_install_exit_cleanup() {
  local _status=$? _failed=0
  trap - EXIT ERR
  if [ "$RC_INSTALL_CLEANUP_RUNNING" = true ]; then exit "$_status"; fi
  RC_INSTALL_CLEANUP_RUNNING=true
  trap '' INT TERM
  set +e

  if ! rc_install_cleanup_heartbeat; then
    printf '  ✗ Could not clean up an installer subprocess or heartbeat log.\n' >&2
    _failed=1
  fi

  if [ -n "$RC_UPDATE_BACKUP_ROOT" ]; then
    if [ "$RC_UPDATE_MUTATION_STARTED" = true ] \
        && ! rc_install_restore_update_backup; then
      printf '  ✗ Could not restore update user files; backup retained at %s\n' \
        "$RC_UPDATE_BACKUP_ROOT" >&2
      _failed=1
    fi
    if [ "$RC_UPDATE_MUTATION_STARTED" != true ] \
        && ! rc_install_discard_update_backup; then
      printf '  ✗ Could not remove the private update backup at %s\n' \
        "$RC_UPDATE_BACKUP_ROOT" >&2
      _failed=1
    fi
  fi

  rc_profile_cleanup_on_exit || _failed=1
  if [ "$_status" -eq 0 ] && [ "$_failed" -ne 0 ]; then _status=1; fi
  exit "$_status"
}

rc_install_on_interrupt() {
  trap '' INT TERM
  if [ -n "${RC_LOG:-}" ]; then
    printf "\n${Y}  ⚠ Interrupted.${N} The installer is stopping safely and remains resumable.\n"
    printf "  Re-run the same command to continue where it left off:\n"
    printf "    ${B}curl -fsSL https://wentor.ai/install.sh | bash${N}\n"
    printf "  ${D}Diagnostic log: ${RC_LOG}${N}\n\n"
  fi
  exit 130
}

rc_profile_redeem() {
  [ -n "$RC_PROFILE_AUTH_TOKEN" ] || return 0
  command -v curl >/dev/null 2>&1 || die "curl is required to redeem a Bootstrap Profile."
  command -v head >/dev/null 2>&1 && head -c 1 </dev/null >/dev/null 2>&1 \
    || die "head with byte-count support is required to redeem a Bootstrap Profile."
  umask 077
  RC_PROFILE_TEMP_PARENT="$(cd -P -- "${TMPDIR:-/tmp}" && pwd -P)" \
    || die "Could not resolve the Bootstrap Profile private temp parent."
  RC_PROFILE_TEMP_ROOT="$(mktemp -d "$RC_PROFILE_TEMP_PARENT/rc-bootstrap-installer.XXXXXX")"
  trap rc_profile_exit_cleanup EXIT
  chmod 700 "$RC_PROFILE_TEMP_ROOT"
  RC_PROFILE_CURL_CONFIG="$RC_PROFILE_TEMP_ROOT/redeem.curl"
  RC_PROFILE_HEADERS="$RC_PROFILE_TEMP_ROOT/headers"
  RC_PROFILE_CAPSULE="$RC_PROFILE_TEMP_ROOT/capsule.json"
  : > "$RC_PROFILE_CURL_CONFIG"
  : > "$RC_PROFILE_HEADERS"
  : > "$RC_PROFILE_CAPSULE"
  chmod 600 "$RC_PROFILE_CURL_CONFIG" "$RC_PROFILE_HEADERS" "$RC_PROFILE_CAPSULE"
  cat > "$RC_PROFILE_CURL_CONFIG" <<EOF
url = "$RC_BOOTSTRAP_REDEEM_URL"
request = "POST"
header = "Authorization: Bearer $RC_PROFILE_AUTH_TOKEN"
header = "Accept: application/json"
header = "Accept-Encoding: identity"
dump-header = "$RC_PROFILE_HEADERS"
fail
silent
show-error
max-redirs = 0
max-filesize = 2097152
proto = "=https"
EOF
  if ! curl -q --config "$RC_PROFILE_CURL_CONFIG" \
      | head -c 2097153 > "$RC_PROFILE_CAPSULE"; then
    unset RC_PROFILE_AUTH_TOKEN
    rm -f "$RC_PROFILE_CURL_CONFIG"
    die "Bootstrap Profile redemption failed. The installation was not modified."
  fi
  unset RC_PROFILE_AUTH_TOKEN
  rm -f "$RC_PROFILE_CURL_CONFIG"
  RC_PROFILE_CURL_CONFIG=""
  if ! rc_profile_validate_redeem_response; then
    rm -f "$RC_PROFILE_HEADERS"
    RC_PROFILE_HEADERS=""
    die "Bootstrap Profile redemption returned invalid metadata or Capsule bytes."
  fi
  rm -f "$RC_PROFILE_HEADERS"
  RC_PROFILE_HEADERS=""
}

rc_profile_assert_gateway_stopped() {
  local _run_lock="${RC_RUN_LOCK_DIR:-${TMPDIR:-/tmp}/research-claw-gateway.lock}"
  local _owner=""
  _owner="$(cat "$_run_lock/pid" 2>/dev/null || true)"
  if [ -n "$_owner" ] && kill -0 "$_owner" 2>/dev/null; then
    die "Research-Claw is running (PID $_owner). Stop it normally, then re-run this installer."
  fi
  if command -v lsof >/dev/null 2>&1; then
    local _listeners
    _listeners="$(lsof -ti :"$PORT" 2>/dev/null || true)"
    [ -z "$_listeners" ] || die "Port $PORT is active. Stop the running Gateway yourself, then re-run."
  fi
}

rc_profile_prepare_native_data_root() {
  local _data_root _created=false _owner _mode
  case "${HOME:-}" in
    /*) _data_root="$HOME/.research-claw" ;;
    *) die "The home directory is unavailable; refusing to prepare the Research-Claw data directory." ;;
  esac

  [ ! -L "$_data_root" ] \
    || die "The Research-Claw data path is a symbolic link; refusing to apply a Bootstrap Profile."
  if [ ! -e "$_data_root" ]; then
    (umask 077; mkdir -- "$_data_root") \
      || die "Could not create the Research-Claw data directory."
    _created=true
  fi
  [ -d "$_data_root" ] && [ ! -L "$_data_root" ] \
    || die "The Research-Claw data path is not a concrete directory."
  _owner="$(rc_install_path_owner "$_data_root")" \
    || die "Could not verify the Research-Claw data directory owner."
  [ "$_owner" = "$(id -u)" ] \
    || die "The Research-Claw data directory is not owned by the current user."
  if $_created; then
    _mode="$(rc_install_path_mode "$_data_root")" \
      || die "Could not verify the Research-Claw data directory permissions."
    [ "$_mode" = 700 ] \
      || die "The new Research-Claw data directory is not private."
  fi
}

rc_profile_recover_native() {
  rc_profile_native_cli initialize-locks >/dev/null
  rc_profile_native_cli recover >/dev/null
  RC_PROFILE_TX_ID=""
  RC_PROFILE_PENDING_STATE=""
}

rc_profile_stage_native() {
  local _result
  if ! _result="$(rc_profile_native_cli stage --capsule-file "$RC_PROFILE_CAPSULE")"; then
    rc_profile_load_pending_native >/dev/null 2>&1 || true
    return 1
  fi
  RC_PROFILE_TX_ID="$(printf '%s' "$_result" | "$GW_NODE" -e '
    let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
      const value=JSON.parse(raw); if (!/^tx-[0-9a-f-]{36}$/.test(value.txId || "")) process.exit(1);
      process.stdout.write(value.txId);
    });
  ')" || die "Bootstrap Profile staging returned an invalid transaction."
  [ -n "$RC_PROFILE_TX_ID" ] || die "Bootstrap Profile staging failed."
}

rc_profile_apply_native() {
  rc_profile_native_cli apply --tx-id "$RC_PROFILE_TX_ID" >/dev/null
}

rc_profile_verify_native() {
  rc_profile_native_cli verify --tx-id "$RC_PROFILE_TX_ID" >/dev/null
}

rc_profile_probe_native() {
  local _provider _profile _probe_output
  read -r _provider _profile <<EOF
$("$GW_NODE" -e '
  const fs=require("fs");
  const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const primary=typeof c.agents?.defaults?.model === "string"
    ? c.agents.defaults.model : c.agents?.defaults?.model?.primary;
  const provider=typeof primary === "string" ? primary.split("/")[0] : "";
  const profile=c.auth?.order?.[provider]?.[0] || "";
  if (!provider || !profile) process.exit(1);
  process.stdout.write(provider+" "+profile);
' "$INSTALL_DIR/config/openclaw.json")
EOF
  [ -n "$_provider" ] && [ -n "$_profile" ] || die "Bootstrap Profile model identity is incomplete."
  _probe_output="$RC_PROFILE_TEMP_ROOT/model-probe.json"
  if ! "$GW_NODE" "$INSTALL_DIR/scripts/bootstrap-profile/model-probe.cjs" \
      --root "$INSTALL_DIR" \
      --config "$INSTALL_DIR/config/openclaw.json" \
      --state "$HOME/.openclaw" \
      --provider "$_provider" \
      --profile "$_profile" \
      --scratch-root "$RC_PROFILE_TEMP_ROOT" >"$_probe_output" 2>/dev/null; then
    die "Bootstrap Profile credential/model probe failed."
  fi
  "$GW_NODE" -e '
    const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if (value?.ok !== true || value?.status !== "ok") process.exit(1);
  ' "$_probe_output" || die "Bootstrap Profile credential/model probe was not accepted."
}

rc_profile_commit_native() {
  local _status
  RC_PROFILE_COMMIT_ATTEMPTED=true
  if ! rc_profile_native_cli commit --tx-id "$RC_PROFILE_TX_ID" >/dev/null; then
    if ! rc_profile_load_pending_native \
        || [ "$RC_PROFILE_PENDING_STATE" != committed ] \
        || ! rc_profile_rollback_native; then
      return 1
    fi
  else
    RC_PROFILE_COMMITTED=true
    RC_PROFILE_TX_ID=""
    RC_PROFILE_PENDING_STATE=""
  fi
  _status="$(rc_profile_native_cli status)"
  printf '%s' "$_status" | "$GW_NODE" -e '
    let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
      const value=JSON.parse(raw), p=value.profile;
      if (p) process.stdout.write(`  ✓ Bootstrap Profile ${p.id} revision ${p.revision}\n`);
    });
  '
  rc_profile_cleanup_host_secret
}

rc_profile_parse_args "$@"
trap 'exit 130' INT TERM
rc_profile_redeem

# ── Diagnostic breadcrumb log ─────────────────────────────────────────
# Key decisions and failure details land here so a failed install has an
# attachable log. Screen output is NOT tee'd (that would break TTY detection
# and progress rendering for child processes).
RC_LOG="${TMPDIR:-/tmp}/rc-install-$(date +%Y%m%d-%H%M%S).log"
rclog() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$RC_LOG" 2>/dev/null || true; }

# From this point onward every path (including the no-token installer) shares
# one EXIT cleanup and one interrupt ABI.
trap rc_install_exit_cleanup EXIT
trap rc_install_on_interrupt INT TERM

INSTALL_START_TS=$(date +%s)
_elapsed() {
  local _s=$(( $(date +%s) - INSTALL_START_TS ))
  printf '%dm%02ds' $((_s / 60)) $((_s % 60))
}

step() { printf "\n${C}  ▸ [%s/8]${N} ${B}%s${N}\n" "$1" "$2"; rclog "step $1/8: $2"; }

# Run a long command with a visible heartbeat instead of dead silence.
# Full output is captured to a temp log. On a TTY one line shows the label and
# elapsed seconds; otherwise a liveness line prints every 15s. Set
# HB_SHOW_FAIL_LOG=1 to dump the log tail on failure (leave unset for attempts
# that have a quieter fallback path).
run_with_heartbeat() {
  local _label="$1"; shift
  local _pid _rc=0 _cleanup_rc=0 _t=0 _old_umask
  [ -z "$RC_HEARTBEAT_PID" ] && [ -z "$RC_HEARTBEAT_LOG" ] || return 125
  rc_install_init_temp_parent || return 1
  _old_umask="$(umask)"
  umask 077
  if ! RC_HEARTBEAT_LOG="$(mktemp "$RC_INSTALL_TEMP_PARENT/rc-install-heartbeat.XXXXXX")"; then
    umask "$_old_umask"
    return 1
  fi
  umask "$_old_umask"
  chmod 600 "$RC_HEARTBEAT_LOG" || return 1
  RC_HEARTBEAT_LOG_ID="$(rc_install_path_identity "$RC_HEARTBEAT_LOG")" || return 1
  "$@" >"$RC_HEARTBEAT_LOG" 2>&1 &
  RC_HEARTBEAT_PID=$!
  _pid="$RC_HEARTBEAT_PID"
  while kill -0 "$_pid" 2>/dev/null; do
    sleep 1
    _t=$((_t + 1))
    if [ -t 1 ]; then
      printf "\r${C}  ▸${N} %s... %ss" "$_label" "$_t"
    elif [ $((_t % 15)) -eq 0 ]; then
      printf "  ▸ %s... %ss elapsed\n" "$_label" "$_t"
    fi
  done
  wait "$_pid" || _rc=$?
  RC_HEARTBEAT_PID=""
  if [ -t 1 ] && [ "$_t" -gt 0 ]; then printf "\r\033[2K"; fi
  if [ "$_rc" -ne 0 ] && [ "${HB_SHOW_FAIL_LOG:-0}" = "1" ] \
      && [ -s "$RC_HEARTBEAT_LOG" ]; then
    warn "$_label failed (exit $_rc). Last output:"
    tail -5 "$RC_HEARTBEAT_LOG" | sed 's/^/      /' >&2
  fi
  rc_install_remove_heartbeat_log || _cleanup_rc=1
  [ "$_rc" -ne 0 ] && return "$_rc"
  return "$_cleanup_rc"
}

ensure_ppt_master() {
  local target_dir="$INSTALL_DIR/ppt-master"
  local scripts_root="$target_dir/skills/ppt-master/scripts"
  local primary_url="$PPT_MASTER_GITHUB"
  local fallback_url="$PPT_MASTER_ATOMGIT"

  if [ -f "$scripts_root/project_manager.py" ] && [ -f "$scripts_root/svg_to_pptx.py" ]; then
    ok "ppt-master ready"
    return 0
  fi

  if [ -f "$INSTALL_DIR/.gitmodules" ] && grep -q 'path = ppt-master' "$INSTALL_DIR/.gitmodules" 2>/dev/null; then
    info "Initializing ppt-master submodule..."
    git -C "$INSTALL_DIR" submodule sync -- ppt-master >/dev/null 2>&1 || true

    # A Gitee main-repository clone must not silently retain a GitHub-only
    # submodule dependency. AtomGit is an upstream-documented mirror and has
    # the pinned gitlink commit; Git still verifies/checks out that exact SHA.
    if [ "$REPO" = "$GITEE_REPO" ]; then
      primary_url="$PPT_MASTER_ATOMGIT"
      fallback_url="$PPT_MASTER_GITHUB"
    fi

    git -C "$INSTALL_DIR" config submodule.ppt-master.url "$primary_url"
    if ! git -C "$INSTALL_DIR" -c http.version=HTTP/1.1 submodule update --init --recursive ppt-master; then
      warn "Primary ppt-master source unavailable; trying the alternate mirror..."
      git -C "$INSTALL_DIR" config submodule.ppt-master.url "$fallback_url"
      if ! git -C "$INSTALL_DIR" -c http.version=HTTP/1.1 submodule update --init --recursive ppt-master; then
        die "Failed to initialize ppt-master from both sources. Re-run this installer when either GitHub or AtomGit is reachable."
      fi
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
printf "  ${D}8 steps · first install ~5-15 min (deps + build) · update ~1-3 min${N}\n"
printf "  ${D}Safe to interrupt: re-running resumes where it left off${N}\n"

# --- [1/8] Platform ---
step 1 "Platform check"
OS="$(uname -s)"
case "$OS" in
  Darwin) RC_OS=mac ;;
  Linux)  RC_OS=linux ;; # Includes WSL2.
  *)      die "Unsupported OS: $OS. Use macOS or Linux." ;;
esac
info "Platform: $OS / $(uname -m)"
rclog "platform: $(uname -a)"

# Disk space preflight (~3 GB for node_modules + build; failing late is the worst UX)
_avail_gb=$(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || df -BG "$HOME" 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')
if [ -n "${_avail_gb:-}" ] && [ "$_avail_gb" -lt 5 ] 2>/dev/null; then
  warn "Low disk space: ${_avail_gb} GB free. Install needs ~3 GB (dependencies + build)."
  rclog "low disk: ${_avail_gb}GB"
fi

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
step 2 "Git"
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
step 3 "Build tools"
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

# Camera capture and RTSP preview both execute ffmpeg at runtime. Install it
# during setup instead of letting those features fail later with ENOENT.
ensure_ffmpeg() {
  if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
    ok "ffmpeg"
    return 0
  fi

  info "Installing ffmpeg (camera and RTSP runtime)..."
  if [ "$RC_OS" = mac ]; then
    if command -v brew &>/dev/null; then
      if ! brew install ffmpeg; then
        warn "ffmpeg installation failed. Camera and RTSP features will remain unavailable."
        warn "Retry later with: brew install ffmpeg"
        return 0
      fi
    else
      warn "Homebrew is not installed, so ffmpeg could not be installed automatically."
      warn "Camera and RTSP features need: https://brew.sh, then brew install ffmpeg"
      return 0
    fi
  else
    if ! pkg_install ffmpeg; then
      warn "ffmpeg installation failed. Camera and RTSP features will remain unavailable."
      warn "Install the ffmpeg package with your Linux distribution, then re-run this installer."
      return 0
    fi
  fi

  if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
    ok "ffmpeg"
  else
    warn "ffmpeg/ffprobe are still unavailable; camera and RTSP features are disabled."
  fi
}
ensure_ffmpeg

# --- Shell-profile block management (idempotent) ---
# Persisted exports are stored as marker-bounded blocks:
#   # >>> research-claw:<id> >>>
#   ...
#   # <<< research-claw:<id> <<<
# On every run we strip ALL matching marker blocks AND legacy un-marked blocks
# from .zshrc/.bashrc/.bash_profile, then write one fresh block to the user's
# primary profile with shell-appropriate syntax. Handles: fresh install,
# clean re-install, legacy buggy block, duplicate legacy blocks, shell switch.
RC_PROFILE_LIST=("$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile")

rc_user_primary_profile() {
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    *)   printf '%s\n' "$HOME/.bashrc" ;;
  esac
}

rc_shell_for_profile() {
  case "$(basename "$1")" in
    .zshrc) printf 'zsh\n' ;;
    *)      printf 'bash\n' ;;
  esac
}

# rc_strip_block <profile> <block_id> [<legacy_first_line>] [<legacy_line_count>]
# Removes every marker-bounded block with the given id, plus every legacy
# block that begins with <legacy_first_line> (skips that line + the next
# <legacy_line_count> - 1 lines). No-op if file missing or unwritable.
rc_strip_block() {
  local profile="$1" block_id="$2" legacy_first="${3:-}" legacy_n="${4:-0}"
  [ -f "$profile" ] || return 0
  [ -w "$profile" ] || return 0

  local start="# >>> research-claw:${block_id} >>>"
  local end="# <<< research-claw:${block_id} <<<"

  if ! grep -qF "$start" "$profile" 2>/dev/null; then
    if [ -z "$legacy_first" ] || ! grep -qFx "$legacy_first" "$profile" 2>/dev/null; then
      return 0
    fi
  fi

  local tmp="${profile}.rcclean.$$"
  if awk -v sm="$start" -v em="$end" -v lg="$legacy_first" -v ln="$legacy_n" '
    BEGIN { inblk = 0; lleft = 0 }
    {
      if (inblk) { if ($0 == em) { inblk = 0 } ; next }
      if (lleft > 0) { lleft--; next }
      if ($0 == sm) { inblk = 1; next }
      if (lg != "" && ln > 0 && $0 == lg) { lleft = ln - 1; next }
      print
    }
  ' "$profile" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$profile"
  else
    rm -f "$tmp"
  fi
}

# rc_append_block <profile> <block_id> <body>
# Idempotent on line count: trims trailing blank lines first, omits leading
# separator when file is empty. Reinstalls produce byte-identical output.
rc_append_block() {
  local profile="$1" block_id="$2" body="$3"
  local start="# >>> research-claw:${block_id} >>>"
  local end="# <<< research-claw:${block_id} <<<"

  if [ ! -e "$profile" ]; then
    : > "$profile" 2>/dev/null || return 1
  fi
  [ -w "$profile" ] || return 1

  if [ -s "$profile" ]; then
    local tmp="${profile}.rcnorm.$$"
    if awk '
      /^[[:space:]]*$/ { tb++; next }
      { for (i = 0; i < tb; i++) print ""; tb = 0; print }
    ' "$profile" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$profile"
    else
      rm -f "$tmp"
    fi
  fi

  if [ -s "$profile" ]; then
    printf '\n%s\n%s\n%s\n' "$start" "$body" "$end" >> "$profile" 2>/dev/null
  else
    printf '%s\n%s\n%s\n' "$start" "$body" "$end" >> "$profile" 2>/dev/null
  fi
}

# rc_install_profile_block <block_id> <legacy_first> <legacy_n> <body_bash> [<body_zsh>]
# Strips stale entries from every candidate profile, then writes one fresh
# block to the user's primary profile (shell-specific body if provided).
rc_install_profile_block() {
  local block_id="$1" legacy_first="$2" legacy_n="$3"
  local body_bash="$4" body_zsh="${5:-$4}"

  local p
  for p in "${RC_PROFILE_LIST[@]}"; do
    rc_strip_block "$p" "$block_id" "$legacy_first" "$legacy_n"
  done

  local primary
  primary="$(rc_user_primary_profile)"
  local body
  case "$(rc_shell_for_profile "$primary")" in
    zsh) body="$body_zsh" ;;
    *)   body="$body_bash" ;;
  esac
  rc_append_block "$primary" "$block_id" "$body"
}

# --- [4/8] Node.js 22 LTS ---
step 4 "Node.js runtime"
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

  # Persist to shell profile — idempotent, shell-aware.
  # zsh users get --shell zsh; using --shell bash here breaks zsh tab-completion.
  local FNM_BODY_BASH='export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --use-on-cd --shell bash)"'
  local FNM_BODY_ZSH='export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --use-on-cd --shell zsh)"'
  if ! rc_install_profile_block "fnm" "# fnm (added by Research-Claw)" 3 "$FNM_BODY_BASH" "$FNM_BODY_ZSH"; then
    warn "Could not persist fnm config to $(rc_user_primary_profile)."
    warn "fnm works for this session but won't persist across new terminals."
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
    if [ "$NODE_V" -eq "$NODE_MIN" ] 2>/dev/null; then
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
    die "Node.js 22 LTS is required but not found."
  fi
  NODE_V="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_V" -ne "$NODE_MIN" ] 2>/dev/null; then
    die "Node.js $(node -v) installed but Research-Claw requires Node 22.x."
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
    ":$bin_dir:"*) ;;
    *) export PATH="$bin_dir:$PATH" ;;
  esac
  hash -r 2>/dev/null || true
  return 0
}

pnpm_version() {
  # pnpm 10 defaults manage-package-manager-versions=true. During a first-hop
  # upgrade, an old checkout can therefore make the freshly installed pnpm 10
  # report (and execute as) pnpm 9 from that checkout's packageManager field.
  # Probe the candidate itself so verification is independent of the cwd.
  npm_config_manage_package_manager_versions=false "$1" --version 2>/dev/null
}

pnpm_cmd_works() {
  local candidate="${1:-pnpm}" detected_version
  if [[ "$candidate" == */* ]]; then
    [ -x "$candidate" ] || return 1
  else
    command -v "$candidate" &>/dev/null || return 1
  fi
  detected_version="$(pnpm_version "$candidate")" || return 1
  [ "$detected_version" = "$PNPM_VERSION" ]
}

install_private_pnpm() {
  mkdir -p "$RC_PNPM_PREFIX"
  info "Installing standalone pnpm $PNPM_VERSION..."
  npm install --prefix "$RC_PNPM_PREFIX" -g "pnpm@$PNPM_VERSION"
  activate_private_pnpm
}

ensure_pnpm() {
  local detected_version="" private_pnpm="$RC_PNPM_PREFIX/bin/pnpm"
  if pnpm_cmd_works; then
    PNPM_BIN="$(command -v pnpm)"
    ok "pnpm $(pnpm_version "$PNPM_BIN")"
    return 0
  fi

  activate_private_pnpm || true
  if pnpm_cmd_works "$private_pnpm"; then
    PNPM_BIN="$private_pnpm"
    ok "pnpm $(pnpm_version "$PNPM_BIN")"
    return 0
  fi

  if command -v pnpm &>/dev/null; then
    detected_version="$(pnpm_version pnpm || true)"
  fi
  if [ -n "$detected_version" ]; then
    warn "pnpm $detected_version does not match required $PNPM_VERSION. Installing an isolated compatible copy."
  else
    warn "pnpm is unavailable or its Corepack shim is broken. Installing an isolated compatible copy."
  fi
  if ! install_private_pnpm || ! pnpm_cmd_works "$private_pnpm"; then
    die "pnpm installation failed. Install manually: npm install --prefix $RC_PNPM_PREFIX -g pnpm@$PNPM_VERSION"
  fi

  PNPM_BIN="$private_pnpm"
  ok "pnpm $(pnpm_version "$PNPM_BIN")"
}

# --- Disable Corepack strict mode ---
# Node 22+ enables Corepack by default. If a parent directory (e.g. ~/) has a
# package.json with "packageManager": "yarn@...", Corepack blocks pnpm with
# "This project is configured to use yarn" and causes "Invalid package.json".
export COREPACK_ENABLE_STRICT=0
export COREPACK_ENABLE_AUTO_PIN=0

# --- Never let git block on an interactive credential prompt ---
# The default remote is a Gitee mirror. Gitee intermittently returns HTTP 401 for
# anonymous fetch (content review/freeze, WAF challenge, or rate-limit). Without
# these guards, `git pull` opens /dev/tty and hangs forever on
# "Username for 'https://gitee.com':" — note `2>/dev/null` does NOT suppress this,
# the prompt is written to the terminal, not stderr. Disabling the prompt turns a
# 401 into an immediate non-zero exit, which lets the GitHub-mirror fallback run.
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=Never
export GIT_ASKPASS=true

# --- Git proxy preflight ---
# git's http.proxy CONFIG takes precedence over HTTP(S)_PROXY env vars, so a
# stale proxy port left in ~/.gitconfig (e.g. after a proxy client changed its
# port) breaks every clone/pull even when the shell proxy env is correct.
# Strategy: probe the configured proxy's TCP port; if dead, override it for
# THIS script's git commands only (env proxy if alive, otherwise direct).
# Never rewrite the user's git config — print the fix and let them decide.

# Append an env-level git config override. Applies to every git command this
# script (and its children, incl. submodule clones) runs, without touching
# the user's git config files.
add_git_config() {
  local n="${GIT_CONFIG_COUNT:-0}"
  export "GIT_CONFIG_KEY_${n}=$1" "GIT_CONFIG_VALUE_${n}=$2"
  export GIT_CONFIG_COUNT=$((n + 1))
}

# TCP-probe the host:port of a proxy URL (http://host:port, socks5://host:port).
# Returns 0 if connectable, 1 if not, 0 if the URL has no explicit port (can't
# judge cheaply — don't interfere).
_proxy_alive() {
  local hostport host port
  hostport="${1#*://}"; hostport="${hostport%%/*}"; hostport="${hostport##*@}"
  host="${hostport%%:*}"; port="${hostport##*:}"
  [ -n "$host" ] && [ -n "$port" ] && [ "$host" != "$port" ] || return 0
  if command -v nc &>/dev/null; then
    nc -z -w 2 "$host" "$port" &>/dev/null
  else
    (exec 3<>"/dev/tcp/$host/$port") &>/dev/null
  fi
}

preflight_git_proxy() {
  local cfg_http cfg_https dead="" env_proxy
  cfg_http="$(git config --get http.proxy 2>/dev/null || true)"
  cfg_https="$(git config --get https.proxy 2>/dev/null || true)"
  [ -z "$cfg_http" ] && [ -z "$cfg_https" ] && return 0

  local cfg
  for cfg in "$cfg_http" "$cfg_https"; do
    if [ -n "$cfg" ] && ! _proxy_alive "$cfg"; then dead="$cfg"; break; fi
  done
  [ -z "$dead" ] && return 0

  warn "Your git config sets a proxy that is not responding: $dead"
  warn "(git config proxy OVERRIDES the HTTP_PROXY/HTTPS_PROXY environment variables)"
  env_proxy="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
  if [ -n "$env_proxy" ] && _proxy_alive "$env_proxy"; then
    warn "Using your environment proxy for this install instead: $env_proxy"
    add_git_config "http.proxy" "$env_proxy"
    add_git_config "https.proxy" "$env_proxy"
  else
    warn "Connecting directly (no proxy) for this install."
    add_git_config "http.proxy" ""
    add_git_config "https.proxy" ""
  fi
  warn "Your git config was NOT modified. To fix it permanently:"
  warn "  git config --global --unset http.proxy; git config --global --unset https.proxy"
}

preflight_git_proxy

# --- [5/8] Clone or update ---
step 5 "Fetch source"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"

  # --- Preserve user data files before git operations ---
  # L3 user-owned (SOUL, IDENTITY, TOOLS, USER) + L2 sentinel (BOOTSTRAP.md.done)
  # + workspace-level files are gitignored, but we backup for safety in case of
  # migration from older versions where they were still tracked.
  rc_install_snapshot_update_backup \
    || die "Could not preserve user files before updating. The installation was not modified."

  # Recover from interrupted rebase/merge (e.g. user Ctrl+C during update)
  RC_UPDATE_MUTATION_STARTED=true
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git reset --hard HEAD 2>/dev/null || true
  # Remove untracked files that may conflict with incoming changes.
  # Gitignored files (config, data, node_modules, workspace runtime) are preserved.
  git clean -fd 2>/dev/null || true
  # --- Self-healing dual-remote update ---
  # Try the existing origin first. If it fails, select the other official
  # mirror instead of blindly retrying the same host. Do not permanently
  # re-point origin: each installation keeps its preferred source next time.
  _BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  [ "$_BRANCH" = "HEAD" ] && _BRANCH="main"
  _PULLED=false
  if run_with_heartbeat "Updating from origin" git pull --rebase --autostash; then
    _PULLED=true
  else
    git rebase --abort 2>/dev/null || true
    git reset --hard HEAD 2>/dev/null || true
    _ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
    _FALLBACK_REMOTE=github
    _FALLBACK_REPO="$GITHUB_REPO"
    _FALLBACK_LABEL=GitHub
    case "$_ORIGIN_URL" in
      *github.com*wentorai*Research-Claw.git*)
        _FALLBACK_REMOTE=gitee
        _FALLBACK_REPO="$GITEE_REPO"
        _FALLBACK_LABEL=Gitee
        ;;
    esac
    warn "Update from origin failed — trying $_FALLBACK_LABEL mirror..."
    git remote set-url "$_FALLBACK_REMOTE" "$_FALLBACK_REPO" 2>/dev/null \
      || git remote add "$_FALLBACK_REMOTE" "$_FALLBACK_REPO" 2>/dev/null || true
    if HB_SHOW_FAIL_LOG=1 run_with_heartbeat "Updating from $_FALLBACK_LABEL mirror" \
       git fetch --depth 1 "$_FALLBACK_REMOTE" "$_BRANCH" \
       && (git reset --hard "$_FALLBACK_REMOTE/$_BRANCH" 2>/dev/null \
         || git reset --hard FETCH_HEAD 2>/dev/null); then
      _PULLED=true
      ok "Updated from $_FALLBACK_LABEL mirror"
    fi
  fi

  if ! $_PULLED; then
    warn "git pull failed. Possible causes:"
    warn "  - Network issue (try again later)"
    warn "  - VPN/proxy interference (try disabling VPN or switching to direct connection)"
    warn "  - Stale git proxy config (check: git config --get http.proxy)"
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

  # --- Restore user data files before discarding the private snapshot ---
  rc_install_restore_update_backup \
    || die "Could not restore user files after updating. The private backup was retained."
  rc_install_discard_update_backup \
    || die "Could not remove the private update backup after restoring user files."

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
        warn "  - Stale git proxy config (check: git config --get http.proxy)"
        die "Clone failed. Check your network and try again."
      fi
    else
      warn "Failed to clone repository. Possible causes:"
      warn "  - Network issue (repository unreachable)"
      warn "  - VPN/proxy interference (try disabling VPN virtual adapter mode)"
      warn "  - Stale git proxy config (check: git config --get http.proxy)"
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
add_git_config "url.https://github.com/.insteadOf" "git@github.com:"

# --- [5/8 cont.] pnpm ---
if ! $UPDATE_FAILED; then
  ensure_pnpm
fi

# Resolve the exact runtime from the checked-out repository. Installation,
# native compilation, build, and Gateway launch must share this executable.
if ! _RC_NODE_SHELL=$(node "$INSTALL_DIR/scripts/node-runtime.cjs" resolve --shell); then
  die "Could not resolve the required Node 22 runtime."
fi
eval "$_RC_NODE_SHELL"
unset _RC_NODE_SHELL
GW_NODE="$RC_NODE_PATH"
GW_NODE_DIR="$RC_NODE_DIR"
export PATH="$GW_NODE_DIR:$PATH"
info "Gateway Node: v$RC_NODE_VERSION (ABI $RC_NODE_ABI)"

step 6 "Install dependencies + build (the longest step)"
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

# Diagnose a failed pnpm install: if a native module failed to COMPILE via
# node-gyp (happens when no prebuilt binary matches this Node/platform), the
# problem is the local C/C++ toolchain, not the network — say so explicitly.
_hint_native_build_failure() {
  grep -q "gyp ERR" "$1" 2>/dev/null || return 0
  warn "A native module failed to compile (node-gyp). Your C/C++ toolchain is broken or missing."
  if [ "$(uname -s)" = "Darwin" ]; then
    warn "Fix (macOS) — reinstall Xcode Command Line Tools, then re-run this installer:"
    warn "  sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
  else
    warn "Fix (Linux) — install build tools, then re-run this installer:"
    warn "  sudo apt-get install -y build-essential python3   # Debian/Ubuntu"
  fi
  warn "Alternative: switch to Node.js $NODE_MIN LTS — prebuilt binaries, no compilation needed."
}

_pnpm_install_with_diagnostics() {
  local _log
  _log="$(mktemp)"
  if ! (_pnpm_install --frozen-lockfile 2>/dev/null || _pnpm_install) 2>&1 | tee "$_log"; then
    _hint_native_build_failure "$_log"
    rm -f "$_log"
    return 1
  fi
  rm -f "$_log"
}
if ! $UPDATE_FAILED; then
  info "Installing dependencies (~1-3 min, pnpm output streams below)..."
  if ! _pnpm_install_with_diagnostics; then
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
# Run from the project root so both pnpm's relative bin shim and OpenClaw's
# project-relative plugin paths resolve against the installed Research-Claw.
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
if cd "${INSTALL_DIR}" 2>/dev/null; then
  export OPENCLAW_CONFIG_PATH="${INSTALL_DIR}/config/openclaw.json"
  exec ./node_modules/.bin/openclaw "\$@"
fi
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

RC_CONFIG_CREATED=0
if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    chmod 600 config/openclaw.json
    RC_CONFIG_CREATED=1
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
  # A durable, gitignored marker distinguishes this managed native install from
  # a source worktree even though both later use `pnpm serve`. The helper owns
  # the one-time legacy warn→error migration and stops managing logging as soon
  # as the operator makes an explicit choice.
  if ! node scripts/log-profile.cjs mark-native \
      --root "$INSTALL_DIR" \
      --config "$INSTALL_DIR/config/openclaw.json" \
      --fresh "$RC_CONFIG_CREATED" >/dev/null; then
    die "Could not record the native-install log profile. Existing config was kept."
  fi
  node scripts/migrate-rc-data-dir.cjs 2>/dev/null || true
  # Clean stale references + ensure OC 2026.6.1+ required fields.
  # Shared logic in ensure-config.cjs — also called by run.sh and docker-entrypoint.sh.
  GLOBAL_CFG="$HOME/.openclaw/openclaw.json"
  node scripts/ensure-config.cjs --inherit-global-compaction \
    config/openclaw.json ${GLOBAL_CFG:+"$GLOBAL_CFG"} 2>/dev/null || true
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

# --- Sync HEARTBEAT.md to workspace root ---
# OC's heartbeat system reads workspace/HEARTBEAT.md directly (not .ResearchClaw/).
# Only HEARTBEAT.md is mirrored to root; the other relocatable prompts
# (AGENTS/SOUL/TOOLS/IDENTITY/USER/BOOTSTRAP) get a workspace-root SYMLINK from
# migratePromptFiles() — cp'ing them here would only get renamed to .bak.
RC_DIR="workspace/.ResearchClaw"
[ -f "$RC_DIR/HEARTBEAT.md" ] && cp "$RC_DIR/HEARTBEAT.md" "workspace/HEARTBEAT.md"

# --- Initialize L2/L3 bootstrap runtime files from .example templates ---
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$RC_DIR/$f.example" ] && \
    cp "$RC_DIR/$f.example" "$RC_DIR/$f"
done
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md"
# NOTE: do NOT seed a root workspace/USER.md — migratePromptFiles() seeds
# .ResearchClaw/USER.md and leaves a root symlink; a real root file would only
# be renamed to .bak by the migration.
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md"

if ! $UPDATE_FAILED; then
  if ! HB_SHOW_FAIL_LOG=1 run_with_heartbeat "Building dashboard + extensions (~1-2 min)" \
      env PATH="$GW_NODE_DIR:$PATH" "$PNPM_BIN" build; then
    die "Build failed. Try: cd $INSTALL_DIR && pnpm build"
  fi
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
else
  ok "Existing dependencies and build kept"
fi

step 7 "Native modules check"
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
  if ! _pnpm_install_with_diagnostics; then
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
  else
    ok "Existing native modules OK"
  fi
fi

step 8 "Research plugins"
# --- [8/8] Register research-plugins (skills + agent tools) ---
# Install deterministically into ~/.openclaw/extensions/research-plugins.
# We deliberately do NOT use `openclaw plugins install`: OC 2026.6.1 installs the
# package into <install>/config/npm/projects/<hash>/node_modules/, which the
# gateway loads for the agent tools, but research-claw-core's SkillSearch only
# scans ~/.openclaw/extensions/research-plugins for catalog.json — so skill
# search would silently disable. Installing here (the same layout the Docker
# image bakes) makes the gateway auto-discover the 34 agent tools AND lets
# SkillSearch find catalog.json. NOT loaded from node_modules (avoids pnpm
# hardlink rejection).
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
rp_summary() {
  local SKILLS; SKILLS=$(find "$PLUGIN_DIR/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  [ "$SKILLS" -gt 0 ] 2>/dev/null && echo "${SKILLS} skills" || true
}
# Remove any stale OC-managed install (from older installers that used
# `openclaw plugins install`) so the plugin does not load twice — tools and
# skills now come solely from $PLUGIN_DIR.
rp_cleanup_oc_managed() {
  find "$INSTALL_DIR/config/npm/projects" -maxdepth 1 -type d -name '*research-plugins*' \
    -exec rm -rf {} + 2>/dev/null || true
}

if ! $UPDATE_FAILED; then

# Trap Ctrl+C during plugin install — exit cleanly instead of continuing to gateway
_RP_INTERRUPTED=false
trap '_RP_INTERRUPTED=true' INT

rp_network_hint() {
  warn "If npm is slow, use a China mirror:"
  printf "    ${C}NPM_REGISTRY=https://registry.npmmirror.com${N} curl -fsSL https://wentor.ai/install.sh | bash\n"
}

info "Installing research plugins (network stages can each take up to 2 min)..."
RP_LOG="$(mktemp)"
CURRENT_VER=$(node -e 'console.log(require(process.argv[1]).version)' \
  "$PLUGIN_DIR/package.json" 2>/dev/null || echo "none")
if node "$INSTALL_DIR/scripts/install-research-plugins.cjs" \
    --target "$PLUGIN_DIR" >>"$RP_LOG" 2>&1; then
  rp_cleanup_oc_managed
  NEW_VER=$(node -e 'console.log(require(process.argv[1]).version)' \
    "$PLUGIN_DIR/package.json" 2>/dev/null || echo "unknown")
  if [ "$CURRENT_VER" = "$NEW_VER" ]; then
    RP_S=$(rp_summary); ok "Research-plugins v${NEW_VER}${RP_S:+ ($RP_S)}"
  elif [ "$CURRENT_VER" = "none" ]; then
    RP_S=$(rp_summary); ok "Research-plugins v${NEW_VER}${RP_S:+ ($RP_S)}"
  else
    ok "Research-plugins updated: v${CURRENT_VER} → v${NEW_VER}"
  fi
else
  warn "Research plugins could not be downloaded or prepared."
  warn "Error details (last 5 lines):"
  tail -5 "$RP_LOG" 2>/dev/null | while IFS= read -r line; do printf "    %s\n" "$line"; done
  if node "$INSTALL_DIR/scripts/install-research-plugins.cjs" \
      --check --quiet --target "$PLUGIN_DIR" 2>/dev/null; then
    warn "The existing research plugins were kept at v${CURRENT_VER}."
  else
    warn "Research features are temporarily unavailable; the core assistant can still start."
    warn "Run this installer again to restore research features."
    rp_network_hint
  fi
fi
rm -f "$RP_LOG"

# Restore the installer-wide SIGINT handler; never fall back to Bash default
# before Profile/config validation and the final handoff are complete.
trap rc_install_on_interrupt INT
if $_RP_INTERRUPTED; then
  printf "\n"
  info "Interrupted. Research-plugins can be installed later:"
  printf "    cd $INSTALL_DIR && curl -fsSL https://wentor.ai/install.sh | bash\n"
  info "To start the gateway:"
  printf "    cd $INSTALL_DIR && bash scripts/run.sh\n"
  exit 130
fi

fi  # end: if ! $UPDATE_FAILED (skip build/install/plugins)

# A Profile transaction starts only after the 0.8.3 candidate and optional
# plugin install have reached a terminal state. The existing Gateway is never
# killed: the native path requires the operator's explicit stop proof.
if [ -n "$RC_PROFILE_CAPSULE" ]; then
  $UPDATE_FAILED && die "The 0.8.3 candidate was not installed; refusing to apply a new Bootstrap Profile."
  rc_profile_assert_gateway_stopped
  rc_profile_prepare_native_data_root
  rc_profile_recover_native
  rc_profile_stage_native
  rc_profile_apply_native
fi

# Reconcile plugin configuration only after the optional download has reached a
# terminal state. A missing/partial research-plugins install is removed from the
# load path; a complete install is added back. Then ask the real OpenClaw CLI to
# validate the exact config that the gateway will use.
if [ -f "$INSTALL_DIR/config/openclaw.json" ]; then
  GLOBAL_CFG="$HOME/.openclaw/openclaw.json"
  if ! node "$INSTALL_DIR/scripts/ensure-config.cjs" --inherit-global-compaction \
      "$INSTALL_DIR/config/openclaw.json" ${GLOBAL_CFG:+"$GLOBAL_CFG"}; then
    die "Research-Claw could not finish configuration migration. Run the installer again; your existing files have been kept."
  fi

  VALIDATION_OUTPUT=""
  if ! VALIDATION_OUTPUT=$(
    OPENCLAW_CONFIG_PATH="$INSTALL_DIR/config/openclaw.json" \
      "$INSTALL_DIR/node_modules/.bin/openclaw" config validate --json 2>&1
  ); then
    warn "Research-Claw configuration is not ready, so the gateway was not started."
    printf "%s\n" "$VALIDATION_OUTPUT" | tail -12
    die "Run the installer again after checking the message above."
  fi
fi

if [ -n "$RC_PROFILE_TX_ID" ]; then
  rc_profile_verify_native
  rc_profile_probe_native
  rc_profile_commit_native
fi

if ! node "$INSTALL_DIR/scripts/install-research-plugins.cjs" \
    --check --quiet --target "$PLUGIN_DIR" 2>/dev/null; then
  warn "Research features are temporarily unavailable; the core assistant can still start."
  warn "Run this installer again to restore research features."
elif $UPDATE_FAILED; then
  ok "Existing research plugins kept"
fi

# --- Persist OPENCLAW_CONFIG_PATH in shell profile ---
# Ensures `openclaw config set/get` always targets the RC project config,
# not the vanilla ~/.openclaw/openclaw.json. Idempotent across reinstalls
# (path change automatically replaces, no duplicates).
RC_ENV_LINE="export OPENCLAW_CONFIG_PATH=\"$INSTALL_DIR/config/openclaw.json\""
if rc_install_profile_block "openclaw-config-path" "# Research-Claw config path (added by install.sh)" 2 "$RC_ENV_LINE"; then
  ok "OPENCLAW_CONFIG_PATH → $(rc_user_primary_profile)"
else
  warn "Could not persist OPENCLAW_CONFIG_PATH. Add manually:"
  warn "  $RC_ENV_LINE"
fi

# --- Persist standalone pnpm in shell profile (if installed) ---
# Without this, opening a new terminal and running `pnpm serve` would hit the
# broken Corepack shim again.
if [ -x "$RC_PNPM_PREFIX/bin/pnpm" ]; then
  RC_PNPM_LINE="export PATH=\"$RC_PNPM_PREFIX/bin:\$PATH\""
  rc_install_profile_block "pnpm" "# Standalone pnpm (added by Research-Claw install.sh)" 2 "$RC_PNPM_LINE" || true
fi

# --- Persist ~/.local/bin in shell profile (for openclaw CLI) ---
LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ]; then
  rc_install_profile_block "local-bin" "# ~/.local/bin (added by Research-Claw install.sh)" 2 'export PATH="$HOME/.local/bin:$PATH"' || true
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
printf "\n  ${G}${B}Ready!${N}  ${D}(total $(_elapsed))${N}\n\n"
"$GW_NODE" "$INSTALL_DIR/scripts/version-info.cjs" --root "$INSTALL_DIR" 2>/dev/null \
  | sed 's/^/  /' || true
printf "\n"
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

# --- Launch through the one canonical runtime path ---
info "Starting gateway..."
printf "  ${D}Dashboard will open automatically at${N} ${C}${DASHBOARD_URL}${N}\n"
printf "  ${D}Press Ctrl+C to stop${N}\n\n"

# Open browser when ready (background)
# healthz always checks via loopback (works for both bind modes)
(for _ in $(seq 1 30); do
  if "$GW_NODE" "$INSTALL_DIR/scripts/runtime-readiness.mjs" \
      --root "$INSTALL_DIR" --config "$INSTALL_DIR/config/openclaw.json" \
      --port "$PORT" &>/dev/null; then
    if [ "$RC_OS" = mac ]; then
      open "$DASHBOARD_URL" 2>/dev/null || true
    else
      xdg-open "$DASHBOARD_URL" 2>/dev/null || true
    fi
    exit 0
  fi
  sleep 1
done) &

export PORT
exec bash "$INSTALL_DIR/scripts/run.sh"

} # end _main — do not remove; curl|bash safety depends on this closing brace
_main "$@"
