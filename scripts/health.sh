#!/usr/bin/env bash
# Research-Claw health check — verify gateway + plugin startup chain
set -euo pipefail

PORT="${1:-28789}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$ROOT/config/openclaw.json"
ENTRY_JS="$ROOT/node_modules/openclaw/dist/entry.js"

echo "=== Research-Claw Health Check ==="
echo "Gateway: $BASE"
echo "Project: $ROOT"

# HTTP healthz endpoint
if RESP=$(curl -sf --noproxy '*' "$BASE/healthz" 2>/dev/null); then
  echo "[OK] HTTP healthz responsive"
  echo "     $RESP"
else
  echo "[FAIL] HTTP healthz not responding at $BASE/healthz"
  echo "       Is the gateway running? Start with: pnpm start"
  exit 1
fi

# TCP port check
if command -v nc &>/dev/null; then
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "[OK] TCP port $PORT open"
  else
    echo "[FAIL] TCP port $PORT closed"
    exit 1
  fi
fi

# Dashboard UI
if curl -sf --noproxy '*' "$BASE/" > /dev/null 2>/dev/null; then
  echo "[OK] Dashboard UI accessible"
else
  echo "[WARN] Dashboard UI not responding (gateway may still be starting)"
fi

# Listener process should hold the project config file.
if command -v lsof &>/dev/null; then
  PID="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [ -n "${PID:-}" ]; then
    if lsof -p "$PID" 2>/dev/null | grep -Fq "$CONFIG_PATH"; then
      echo "[OK] Listener pid $PID is using $CONFIG_PATH"
    else
      echo "[WARN] Listener pid $PID is not holding $CONFIG_PATH"
      echo "       This often means the wrong gateway process is bound to $PORT."
    fi
  fi
fi

# Validate that the project config can load the RC plugin.
if [ -f "$ENTRY_JS" ] && [ -f "$CONFIG_PATH" ]; then
  if PLUGINS_OUT="$(OPENCLAW_CONFIG_PATH="$CONFIG_PATH" node "$ENTRY_JS" plugins list 2>/dev/null)"; then
    if printf '%s\n' "$PLUGINS_OUT" | grep -Fq "Research-Claw Core registered"; then
      echo "[OK] research-claw-core registers successfully under project config"
    else
      echo "[FAIL] research-claw-core did not report successful registration"
      echo "       Run: OPENCLAW_CONFIG_PATH=\"$CONFIG_PATH\" node \"$ENTRY_JS\" plugins list"
      exit 1
    fi
  else
    echo "[FAIL] Could not run OpenClaw plugin loader sanity check"
    exit 1
  fi
else
  echo "[WARN] Skipping plugin loader check (missing entry.js or config/openclaw.json)"
fi

echo ""
echo "Gateway startup chain looks healthy."
