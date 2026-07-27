#!/usr/bin/env bash
# Research-Claw one-click diagnostic bundle.
#
# Every collected config, log, audit record, crash snapshot, and health output
# crosses the same redaction boundary before it enters the archive:
# OpenClaw's forced tools-mode redactor plus conservative RC rules for cookies,
# webhook URLs, proxy userinfo, sensitive object keys, and CLI flag/value pairs.
#
# Usage:  bash scripts/diag.sh
#         RC_DIAG_OUT=/some/dir bash scripts/diag.sh
set -u
set -o pipefail
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE_BIN="${RC_NODE:-node}"
REDACTOR="$ROOT/scripts/diag-redact.mjs"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$ROOT/config/openclaw.json}"
TS="${RC_DIAG_TS:-$(date +%Y%m%d-%H%M%S)}"
OUT_DIR="${RC_DIAG_OUT:-$HOME}"
OPENCLAW_STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
case "$OPENCLAW_STATE" in
  "~") OPENCLAW_STATE="$HOME" ;;
  "~/"*) OPENCLAW_STATE="$HOME/${OPENCLAW_STATE#\~/}" ;;
esac

case "$TS" in
  *[!A-Za-z0-9._-]*)
    printf '诊断包生成失败: RC_DIAG_TS 含不安全字符。\n' >&2
    exit 1
    ;;
esac

if ! mkdir -p -- "$OUT_DIR" 2>/dev/null || [ ! -d "$OUT_DIR" ] || [ ! -w "$OUT_DIR" ]; then
  printf '诊断包生成失败: 输出目录不可写: %s\n' "$OUT_DIR" >&2
  exit 1
fi
if [ ! -f "$REDACTOR" ]; then
  printf '诊断包生成失败: 脱敏器不存在: %s\n' "$REDACTOR" >&2
  exit 1
fi

if ! STAGE="$(mktemp -d "${TMPDIR:-/tmp}/rc-diag-XXXXXX")"; then
  printf '诊断包生成失败: 无法创建临时目录。\n' >&2
  exit 1
fi
BUNDLE="$OUT_DIR/rc-diag-$TS.tar.gz"
BUNDLE_TMP="$OUT_DIR/.rc-diag-$TS.tar.gz.tmp.$$"

cleanup() {
  [ -n "${STAGE:-}" ] && [ -d "$STAGE" ] && rm -rf -- "$STAGE"
  [ -n "${BUNDLE_TMP:-}" ] && [ -e "$BUNDLE_TMP" ] && rm -f -- "$BUNDLE_TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM

log()  { printf '  %s\n' "$*"; }
note() { printf '%s\n' "$*" >>"$STAGE/MANIFEST.txt"; }
fail() { printf '诊断包生成失败: %s\n' "$*" >&2; exit 1; }

note "Research-Claw diagnostic bundle — $TS"
note "host: $(uname -a 2>/dev/null)"
note "redaction: best-effort (OpenClaw tools mode + Research-Claw conservative rules)"

if "$NODE_BIN" -e '
  const fs = require("node:fs");
  try {
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(config?.logging?.redactSensitive === "off" ? 0 : 1);
  } catch {
    process.exit(1);
  }
' "$CONFIG_PATH"; then
  log "WARNING: 源配置 logging.redactSensitive=off；诊断包仍强制 best-effort 脱敏，请发送前复核。"
  note "WARNING: source logging.redactSensitive=off; forced diagnostic redaction applied"
fi

redact_file() { # <mode> <source> <destination>
  "$NODE_BIN" "$REDACTOR" "$1" "$2" "$3"
}

redact_stream() { # <destination>
  "$NODE_BIN" "$REDACTOR" text - "$1"
}

grab_tail() { # <source> <destination> <lines>
  local source="$1" destination="$2" lines="${3:-2000}"
  if [ ! -f "$source" ]; then
    note "$(basename "$destination"): MISSING ($source)"
    return 0
  fi
  if tail -n "$lines" -- "$source" 2>/dev/null | redact_stream "$destination"; then
    note "$(basename "$destination"): ok ($(wc -l <"$destination" 2>/dev/null) lines)"
  else
    rm -f -- "$destination"
    note "$(basename "$destination"): REDACTION FAILED"
    return 1
  fi
}

# 1. Versions
if ! {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const readVersion = file => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")).version ?? "?"; }
      catch { return "?"; }
    };
    console.log(`research-claw: ${readVersion(path.join(root, "package.json"))}`);
    console.log(`node: ${process.version}`);
    console.log(`openclaw: ${readVersion(path.join(root, "node_modules", "openclaw", "package.json"))}`);
  ' "$ROOT"
} | redact_stream "$STAGE/versions.txt"; then
  fail "版本信息脱敏失败。"
fi
note "versions.txt: ok"

# 2. Gateway + Research-Claw run logs
mkdir -p "$STAGE/logs"
grab_tail "$HOME/.research-claw/logs/openclaw.log" "$STAGE/logs/openclaw.log" 2000 || \
  fail "openclaw.log 脱敏失败。"
for fileName in run-latest.log run-prev.log; do
  grab_tail "$HOME/.research-claw/logs/$fileName" "$STAGE/logs/$fileName" 5000 || \
    fail "$fileName 脱敏失败。"
done

# Legacy per-day OpenClaw logs (pre-persistent logging.file).
if [ -d /tmp/openclaw ]; then
  while IFS= read -r legacyLog; do
    [ -f "$legacyLog" ] || continue
    grab_tail "$legacyLog" "$STAGE/logs/$(basename "$legacyLog")" 2000 || \
      fail "$(basename "$legacyLog") 脱敏失败。"
  done < <(find /tmp/openclaw -maxdepth 1 -type f -name 'openclaw-*.log' -print 2>/dev/null | sort -r | head -2)
fi

# 3. Stability snapshots + config audit
mkdir -p "$STAGE/stability"
if [ -d "$OPENCLAW_STATE/logs/stability" ]; then
  while IFS= read -r snapshot; do
    [ -f "$snapshot" ] || continue
    destination="$STAGE/stability/$(basename "$snapshot")"
    if redact_file json "$snapshot" "$destination"; then
      note "$(basename "$destination"): redacted"
    else
      rm -f -- "$destination"
      note "$(basename "$destination"): REDACTION FAILED"
      fail "$(basename "$snapshot") 脱敏失败。"
    fi
  done < <(find "$OPENCLAW_STATE/logs/stability" -maxdepth 1 -type f -name '*startup_failed*.json' -print 2>/dev/null | sort -r | head -10)
fi
note "stability snapshots: $(find "$STAGE/stability" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
grab_tail "$OPENCLAW_STATE/logs/config-audit.jsonl" "$STAGE/config-audit.jsonl" 500 || \
  fail "config-audit.jsonl 脱敏失败。"

# 4. Configs: sensitive keys replace the whole value; every remaining string
# still passes through value-pattern redaction.
mkdir -p "$STAGE/config"
redact_config() { # <source> <destination>
  if [ ! -f "$1" ]; then
    note "$(basename "$2"): MISSING ($1)"
    return 0
  fi
  if redact_file json "$1" "$2"; then
    note "$(basename "$2"): redacted"
  else
    rm -f -- "$2"
    note "$(basename "$2"): REDACTION FAILED"
    return 1
  fi
}
redact_config "$CONFIG_PATH" "$STAGE/config/project-openclaw.json" || \
  fail "项目配置脱敏失败。"
redact_config "$OPENCLAW_STATE/openclaw.json" "$STAGE/config/global-openclaw.json" || \
  fail "全局配置脱敏失败。"
if [ -f /app/config/openclaw.json ]; then
  redact_config /app/config/openclaw.json "$STAGE/config/docker-openclaw.json" || \
    fail "Docker 配置脱敏失败。"
fi

# 5. Health output (best-effort command, mandatory redaction boundary).
if [ -f "$ROOT/scripts/health.sh" ]; then
  if ! { bash "$ROOT/scripts/health.sh" 2>&1 || true; } | redact_stream "$STAGE/health.txt"; then
    fail "health 输出脱敏失败。"
  fi
  note "health.txt: ok"
else
  printf 'health.sh not found\n' | redact_stream "$STAGE/health.txt" || \
    fail "health 占位信息脱敏失败。"
  note "health.txt: health.sh not found"
fi

# MANIFEST contains source paths and host metadata, so it crosses the same
# redaction boundary before packaging too.
if ! redact_file text "$STAGE/MANIFEST.txt" "$STAGE/.MANIFEST.safe"; then
  fail "MANIFEST 脱敏失败。"
fi
if ! mv -f -- "$STAGE/.MANIFEST.safe" "$STAGE/MANIFEST.txt"; then
  fail "MANIFEST 写入失败。"
fi

# Package into a protected temporary file. Never report success for a partial,
# empty, or failed archive.
if ! tar czf "$BUNDLE_TMP" -C "$STAGE" . 2>/dev/null; then
  printf '诊断包生成失败: tar 打包失败。\n' >&2
  exit 1
fi
if [ ! -s "$BUNDLE_TMP" ]; then
  printf '诊断包生成失败: 归档为空。\n' >&2
  exit 1
fi
if ! mv -f -- "$BUNDLE_TMP" "$BUNDLE" || ! chmod 600 "$BUNDLE"; then
  printf '诊断包生成失败: 无法写入最终归档。\n' >&2
  exit 1
fi

log ""
log "诊断包已生成: $BUNDLE"
log "可把这个文件发给我们 — 已执行 best-effort 脱敏；发送前仍请复核内容。"
