#!/usr/bin/env bash
# Run in the prepared Ubuntu 24.04 builder. This repo owns its producer commands.
set -eo pipefail
python3 -m pip wheel --no-deps --no-build-isolation --wheel-dir "$AUTOLIFE_OUTPUT_DIR" .

python3 -m pip wheel --no-deps --wheel-dir "$AUTOLIFE_OUTPUT_DIR/dependencies" -r packaging/requirements-runtime.txt
