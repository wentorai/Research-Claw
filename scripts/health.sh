#!/usr/bin/env bash
# Research-Claw health check — verify gateway + plugin startup chain
set -euo pipefail

PORT="${1:-28789}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$ROOT/config/openclaw.json"
ENTRY_JS="$ROOT/node_modules/openclaw/dist/entry.js"
RUNTIME_RESOLVER="$ROOT/scripts/node-runtime.cjs"
READINESS="$ROOT/scripts/runtime-readiness.mjs"

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

# Listener process ownership. macOS `lsof -p PID -d cwd` still emits rows for
# every process unless `-a` intersects the selectors, so omitting `-a` can pick
# an unrelated `/` cwd and falsely accuse the healthy listener. Prefer the
# exact cwd, then accept the exact RC config file as corroborating evidence.
if command -v lsof &>/dev/null; then
  PID="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [ -n "${PID:-}" ]; then
    PROC_CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | grep '^n' | head -n 1 | cut -c2- || true)"
    if [ -n "$PROC_CWD" ] && [[ "$PROC_CWD" == "$ROOT"* ]]; then
      echo "[OK] Listener pid $PID cwd is within project root"
    elif lsof -a -p "$PID" -Fn 2>/dev/null | grep -Fxq "n$CONFIG_PATH"; then
      echo "[OK] Listener pid $PID has the Research-Claw config open"
    else
      echo "[WARN] Listener pid $PID cwd \"$PROC_CWD\" is outside project root $ROOT"
      echo "       This often means the wrong gateway process is bound to $PORT."
    fi
  fi
fi

# Runtime readiness: process liveness is insufficient. Core must have registered
# and representative read-only RPCs must answer through this exact Gateway.
if [ -f "$ENTRY_JS" ] && [ -f "$CONFIG_PATH" ]; then
  if _RC_NODE_SHELL=$(node "$RUNTIME_RESOLVER" resolve --shell); then
    eval "$_RC_NODE_SHELL"
    if "$RC_NODE_PATH" "$READINESS" --root "$ROOT" --config "$CONFIG_PATH" --port "$PORT"; then
      echo "[OK] Research-Claw runtime readiness passed"
    else
      echo "[FAIL] OpenClaw is live, but Research-Claw Core capabilities are unavailable"
      exit 1
    fi
  else
    echo "[FAIL] Could not resolve the Node 22 health-check runtime"
    exit 1
  fi
else
  echo "[FAIL] Missing entry.js or config/openclaw.json"
  exit 1
fi

echo ""
echo "Gateway startup chain looks healthy."
