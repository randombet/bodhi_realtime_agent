#!/usr/bin/env bash
set -euo pipefail

# Python venv for the SpatialReal example bridge (avatar_bridge.py).
# PEP 668: use a venv, not system pip.

cd "$(dirname "$0")"
python3 -m venv .venv
./.venv/bin/python3 -m pip install --upgrade pip
./.venv/bin/python3 -m pip install -r requirements.txt
echo "Venv ready: $(pwd)/.venv/bin/python3"
