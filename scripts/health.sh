#!/usr/bin/env bash
# Research-Claw health check — verify gateway connectivity
set -euo pipefail

PORT="${1:-28789}"
BASE="http://127.0.0.1:${PORT}"

echo "=== Research-Claw Health Check ==="
echo "Gateway: $BASE"

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

echo ""
echo "Gateway is healthy."
