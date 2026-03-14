#!/bin/sh
# Research-Claw Docker entrypoint with auto-restart.
# Gateway exits on SIGUSR1 after config save — this loop restarts it.

# Seed config on first run
if [ ! -f /app/config/openclaw.json ]; then
  mkdir -p /app/config
  cp /defaults/openclaw.example.json /app/config/openclaw.json
  echo "[research-claw] Config initialized from template"
fi

# Generate a gateway token if not provided via env
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n')
  export OPENCLAW_GATEWAY_TOKEN
fi

echo "[research-claw] Starting gateway on port 28789..."
echo "[research-claw] Open dashboard: http://127.0.0.1:28789/?token=$OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] (Tip: set OPENCLAW_GATEWAY_TOKEN env var for a fixed token)"

STOP=false
trap 'STOP=true' INT TERM

while true; do
  OPENCLAW_CONFIG_PATH=/app/config/openclaw.json \
    node /app/node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port 28789 --bind lan --force
  CODE=$?

  if [ "$STOP" = "true" ]; then
    exit 0
  fi

  echo "[research-claw] Gateway exited (code $CODE) — restarting in 1s..."
  sleep 1
done
