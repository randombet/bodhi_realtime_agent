#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Optional one-time setup for examples that need more than `pnpm install` at the repo root.
# Does not run automatically — invoke explicitly: `pnpm examples:setup` or `bash scripts/examples-setup.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: pnpm examples:setup [TARGET]

Targets (default: list):
  spatialreal   Create Python venv for SpatialReal avatar bridge (shared by app + spatialreal example)
  list          Print available targets (default when no argument)

Main install stays a single command from repo root:
  pnpm install

Example-specific extras are opt-in here so CI and day-to-day framework work are not coupled to
Python venvs or other demo-only setup.
EOF
}

case "${1:-list}" in
  -h|--help|help)
    usage
    exit 0
    ;;
  list|"")
    echo "Optional example setup targets:"
    echo "  spatialreal  —  cd app/lib/spatialreal/bridge && ./setup-venv.sh"
    echo ""
    echo "Run: pnpm examples:setup spatialreal"
    ;;
  spatialreal)
    BRIDGE="$ROOT/app/lib/spatialreal/bridge"
    if [[ ! -f "$BRIDGE/setup-venv.sh" ]]; then
      echo "error: missing $BRIDGE/setup-venv.sh" >&2
      exit 1
    fi
    (cd "$BRIDGE" && ./setup-venv.sh)
    echo "SpatialReal venv ready (see examples/spatialreal_avatar_websdk/README.md)."
    ;;
  *)
    echo "error: unknown target: $1" >&2
    usage >&2
    exit 1
    ;;
esac
