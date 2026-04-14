#!/usr/bin/env bash
set -euo pipefail

# Bring toolchains onto PATH (vercel-install.sh put them here).
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# shellcheck disable=SC1090
. "$HOME/.cargo/env"

# Topological build: den-core (Rust → WASM) → @denaudio/core → @denaudio/worklet → @denaudio/effects → @denaudio/examples
# vp run build uses the monorepo dependency graph to order this correctly.
vp run build

echo "✓ vercel-build complete → packages/examples/dist"
