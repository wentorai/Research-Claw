#!/usr/bin/env bash
# Research-Claw one-click diagnostic bundle.
#
# Collects the log/diagnostic artifacts that already exist on disk (OpenClaw's
# own logs + crash snapshots + Research-Claw's run logs) plus a REDACTED copy of
# the config, into a single tarball to attach to a bug report.
#
# Secret safety: config redaction is KEY-NAME driven — any value under a key
# matching key/token/secret/password/credential/auth is replaced, regardless of
# the value's shape. This catches bare-hex API keys (e.g. Elsevier) that a
# value-pattern scanner would miss. Nothing here transmits data anywhere; it
# only writes a local tarball.
#
# Usage:  bash scripts/diag.sh              (native)
#         RC_DIAG_OUT=/some/dir bash scripts/diag.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Timestamp is passed in when scripted; else derive one.
TS="${RC_DIAG_TS:-$(date +%Y%m%d-%H%M%S)}"
OUT_DIR="${RC_DIAG_OUT:-$HOME}"
OPENCLAW_STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
case "$OPENCLAW_STATE" in
  "~") OPENCLAW_STATE="$HOME" ;;
  "~/"*) OPENCLAW_STATE="$HOME/${OPENCLAW_STATE#\~/}" ;;
esac
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/rc-diag-XXXXXX")"
BUNDLE="$OUT_DIR/rc-diag-$TS.tar.gz"

log()  { printf '  %s\n' "$*"; }
note() { printf '%s\n' "$*" >>"$STAGE/MANIFEST.txt"; }

note "Research-Claw diagnostic bundle — $TS"
note "host: $(uname -a 2>/dev/null)"

# --- 1. Versions ---
{
  echo "research-claw: $(node -e "try{console.log(require('$ROOT/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
  echo "node: $(node -v 2>/dev/null)"
  echo "openclaw: $(node -e "try{console.log(require('$ROOT/node_modules/openclaw/package.json').version)}catch{console.log('?')}" 2>/dev/null)"
} > "$STAGE/versions.txt" 2>/dev/null
note "versions.txt: ok"

# --- 2. Gateway file log (T4 persistent path + legacy /tmp/openclaw) ---
_grab_tail() { # <src> <dst> <lines>
  if [ -f "$1" ]; then tail -n "${3:-2000}" "$1" > "$2" 2>/dev/null && note "$(basename "$2"): ok ($(wc -l <"$2" 2>/dev/null) lines)"; else note "$(basename "$2"): MISSING ($1)"; fi
}
mkdir -p "$STAGE/logs"
_grab_tail "$HOME/.research-claw/logs/openclaw.log" "$STAGE/logs/openclaw.log" 2000
# Legacy per-day logs in /tmp (pre-T4); grab the two most recent if present.
if [ -d /tmp/openclaw ]; then
  ls -t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -2 | while read -r f; do
    [ -f "$f" ] && tail -n 2000 "$f" > "$STAGE/logs/$(basename "$f")" 2>/dev/null
  done
  note "legacy /tmp/openclaw logs: collected $(ls "$STAGE"/logs/openclaw-*.log 2>/dev/null | wc -l | tr -d ' ')"
fi

# --- 3. Research-Claw run logs (T4) ---
for f in run-latest.log run-prev.log; do
  _grab_tail "$HOME/.research-claw/logs/$f" "$STAGE/logs/$f" 5000
done

# --- 4. OpenClaw stability crash snapshots (recent) + config-audit ---
mkdir -p "$STAGE/stability"
if [ -d "$OPENCLAW_STATE/logs/stability" ]; then
  # Copy the 10 most recent startup_failed snapshots.
  ls -t "$OPENCLAW_STATE/logs/stability"/*startup_failed*.json 2>/dev/null | head -10 | while read -r f; do
    [ -f "$f" ] && cp "$f" "$STAGE/stability/" 2>/dev/null
  done
  note "stability snapshots: $(ls "$STAGE"/stability/ 2>/dev/null | wc -l | tr -d ' ')"
else
  note "stability snapshots: MISSING"
fi
_grab_tail "$OPENCLAW_STATE/logs/config-audit.jsonl" "$STAGE/config-audit.jsonl" 500

# --- 5. Redacted configs (KEY-NAME driven redaction) ---
mkdir -p "$STAGE/config"
_redact_config() { # <src> <dst>
  [ -f "$1" ] || { note "$(basename "$2"): MISSING ($1)"; return; }
  node -e "
    const fs=require('fs');
    const SENSITIVE=/key|token|secret|password|passwd|credential|auth/i;
    function redact(o){
      if(Array.isArray(o)) return o.map(redact);
      if(o&&typeof o==='object'){const r={};for(const [k,v] of Object.entries(o)){
        r[k]=(SENSITIVE.test(k)&&(typeof v==='string'||typeof v==='number')&&String(v).length>0)?'***REDACTED***':redact(v);
      }return r;}
      return o;
    }
    try{const c=JSON.parse(fs.readFileSync('$1','utf8'));fs.writeFileSync('$2',JSON.stringify(redact(c),null,2));process.exit(0);}
    catch(e){fs.writeFileSync('$2','// unreadable: '+e.message);process.exit(0);}
  " 2>/dev/null && note "$(basename "$2"): redacted"
}
_redact_config "$ROOT/config/openclaw.json" "$STAGE/config/project-openclaw.json"
_redact_config "$OPENCLAW_STATE/openclaw.json" "$STAGE/config/global-openclaw.json"
# Docker path (present only in container).
[ -f /app/config/openclaw.json ] && _redact_config /app/config/openclaw.json "$STAGE/config/docker-openclaw.json"

# --- 6. Health check (best-effort; degraded if gateway not running) ---
if [ -f "$ROOT/scripts/health.sh" ]; then
  bash "$ROOT/scripts/health.sh" > "$STAGE/health.txt" 2>&1 || true
  note "health.txt: ok"
else
  note "health.txt: health.sh not found"
fi

# --- Package ---
tar czf "$BUNDLE" -C "$STAGE" . 2>/dev/null
rm -rf "$STAGE"

log ""
log "诊断包已生成: $BUNDLE"
log "把这个文件发给我们即可 — 已自动脱敏 API Key / Token。"
