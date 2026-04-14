#!/usr/bin/env bash
set -euo pipefail

# vercel-install.sh installed cargo into ~/.cargo, wasm-opt into
# ~/.local/bin, vp into ~/.vite-plus/bin. This stage runs in a fresh
# shell so re-export PATH and re-source cargo env.
export PATH="$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
fi

# Topological build: den-core (Rust → WASM) → @denaudio/core →
# @denaudio/worklet → @denaudio/effects → @denaudio/test-utils →
# @denaudio/examples. `vp run build` (recursive via root script) walks
# the workspace dependency graph in order.
vp run build

echo "✓ vercel-build complete → packages/examples/dist"
