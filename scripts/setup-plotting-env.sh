#!/usr/bin/env bash
# setup-plotting-env.sh — Install plotting dependencies for Research-Claw (native only)
#
# Docker users: dependencies are pre-installed in the Docker image.
# Native users: run this script once to enable Python/SVG figure generation.
#
# Usage:  bash scripts/setup-plotting-env.sh
# Time:   ~30 seconds on fast connection
# Safe:   idempotent, does not modify system Python or install.sh

set -euo pipefail

echo "=== Research-Claw Plotting Environment Setup ==="

# ── Detect Python ────────────────────────────────────────────
PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" &>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: Python not found. Please install Python 3.9+ first."
  exit 1
fi

echo "Using Python: $($PYTHON --version 2>&1)"

# ── Install pip packages ────────────────────────────────────
PACKAGES=(matplotlib seaborn numpy pandas svgwrite)

# cairosvg needs system libcairo; skip if cairo headers missing
HAS_CAIRO=false
if pkg-config --exists cairo 2>/dev/null; then
  HAS_CAIRO=true
elif [ "$(uname)" = "Darwin" ] && brew list cairo &>/dev/null; then
  HAS_CAIRO=true
fi

if $HAS_CAIRO; then
  PACKAGES+=(cairosvg)
else
  echo "NOTE: libcairo not found. Skipping cairosvg (SVG-to-PNG conversion)."
  if [ "$(uname)" = "Darwin" ]; then
    echo "      To install on macOS: brew install cairo"
  else
    echo "      To install on Debian/Ubuntu: sudo apt install libcairo2-dev"
  fi
fi

echo "Installing: ${PACKAGES[*]}"
$PYTHON -m pip install --quiet --upgrade "${PACKAGES[@]}"

# ── Verify ──────────────────────────────────────────────────
echo ""
echo "Verification:"
$PYTHON -c "import matplotlib; print(f'  matplotlib {matplotlib.__version__} OK')"
$PYTHON -c "import seaborn; print(f'  seaborn {seaborn.__version__} OK')"
$PYTHON -c "import svgwrite; print(f'  svgwrite {svgwrite.__version__} OK')"
$PYTHON -c "import cairosvg; print(f'  cairosvg OK')" 2>/dev/null || echo "  cairosvg: not available (optional)"

echo ""
echo "=== Plotting environment ready ==="
