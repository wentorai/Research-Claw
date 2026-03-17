#!/bin/sh
# Research-Claw Docker entrypoint with auto-restart.
# Gateway exits on SIGUSR1 after config save — this loop restarts it.

CONFIG_DIR=/app/config
CONFIG_FILE=$CONFIG_DIR/openclaw.json
CONFIG_VERSION_FILE=$CONFIG_DIR/.config-version
IMAGE_VERSION="0.5.0"

# Seed or refresh config when image version changes
mkdir -p "$CONFIG_DIR"
CURRENT_VERSION=""
if [ -f "$CONFIG_VERSION_FILE" ]; then
  CURRENT_VERSION=$(cat "$CONFIG_VERSION_FILE")
fi

if [ ! -f "$CONFIG_FILE" ] || [ "$CURRENT_VERSION" != "$IMAGE_VERSION" ]; then
  cp /defaults/openclaw.example.json "$CONFIG_FILE"
  echo "$IMAGE_VERSION" > "$CONFIG_VERSION_FILE"
  echo "[research-claw] Config initialized/updated for v$IMAGE_VERSION"
fi

# Default gateway token matches dashboard's DEFAULT_TOKEN for seamless access.
# Override via env: docker run -e OPENCLAW_GATEWAY_TOKEN=your-secret ...
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  OPENCLAW_GATEWAY_TOKEN="research-claw"
  export OPENCLAW_GATEWAY_TOKEN
fi

echo "[research-claw] Starting gateway on port 28789..."
echo "[research-claw] Open dashboard: http://127.0.0.1:28789/?token=$OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] (Tip: set OPENCLAW_GATEWAY_TOKEN env var for a fixed token)"

STOP=false
trap 'STOP=true' INT TERM

while true; do
  OPENCLAW_CONFIG_PATH=$CONFIG_FILE \
    node /app/node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port 28789 --bind lan --force
  CODE=$?

  if [ "$STOP" = "true" ]; then
    exit 0
  fi

  echo "[research-claw] Gateway exited (code $CODE) — restarting in 3s..."
  sleep 3
done
