#!/usr/bin/env bash
set -euo pipefail

# Vercel native GitHub integration's install step. Vercel's build env
# does NOT pre-install our toolchain (Rust, binaryen, Vite+), so we
# install everything idempotently. Build cache persists between builds
# in the same project, so warm builds short-circuit each install guard
# and only re-run `vp install`.
#
# Note on guards: each tool checks for its installed binary path
# directly (e.g., `[ -x "$HOME/.cargo/bin/cargo" ]`) rather than
# `command -v ...`, because Vercel runs this script in a fresh
# non-interactive bash that doesn't source ~/.bashrc — the install
# scripts add their dirs to bashrc but a fresh shell wouldn't see
# them, so `command -v` would falsely report "not installed" on warm
# builds and re-run the installer needlessly.

# --- Rust + wasm32 target -------------------------------------------------
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown
fi
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# --- binaryen (wasm-opt) --------------------------------------------------
# Build from source via cmake when available (~30s, deterministic, no
# glibc surprises on whichever Vercel build image we land on). Fall back
# to the upstream prebuilt tarball when cmake isn't present (issue #4
# §8 Fallback #2).
BINARYEN_VERSION="version_129"
if [ ! -x "$HOME/.local/bin/wasm-opt" ] && ! command -v wasm-opt >/dev/null; then
  mkdir -p "$HOME/.local/bin"
  if command -v cmake >/dev/null; then
    BUILD_DIR="$(mktemp -d)"
    git clone --depth 1 --branch "${BINARYEN_VERSION}" \
      https://github.com/WebAssembly/binaryen.git "$BUILD_DIR"
    cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" \
      -DBUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$HOME/.local"
    cmake --build "$BUILD_DIR/build" --target wasm-opt --parallel
    # binaryen's CMake doesn't always define a `wasm-opt` install
    # component; fall back to copying the built binary directly.
    cmake --install "$BUILD_DIR/build" --component wasm-opt 2>/dev/null \
      || cp "$BUILD_DIR/build/bin/wasm-opt" "$HOME/.local/bin/"
    rm -rf "$BUILD_DIR"
  else
    echo "cmake unavailable; falling back to prebuilt binaryen tarball" >&2
    curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
      | tar xz -C "$HOME/.local" --strip-components=1
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

# --- Vite+ (`vp`) ---------------------------------------------------------
# Installs to $VP_HOME (default ~/.vite-plus) — verified by reading
# https://vite.plus 2026-04-14. The official installer also writes
# shell-rc snippets, but the next stage (vercel-build.sh) starts a
# fresh shell that won't source ~/.bashrc, so we add the bin dir to
# PATH explicitly here AND re-export it in vercel-build.sh.
#
# VP_NODE_MANAGER=yes opts in to Vite+'s bundled Node.js shims
# (`bin/node`, `bin/npm`, `bin/npx`) which read `.node-version` for
# the right version. Without it, the installer prompts interactively
# and would hang in CI. We want vp's managed node either way so the
# resolved Node version matches what the workspace expects (.node-
# version pins 22).
export VP_NODE_MANAGER=yes
if [ ! -x "$HOME/.vite-plus/bin/vp" ]; then
  curl -fsSL https://vite.plus | bash
fi
export PATH="$HOME/.vite-plus/bin:$PATH"

# --- Install workspace deps (Vite+ wraps pnpm; uses .node-version + pnpm-workspace.yaml) ---
vp install --frozen-lockfile

echo "✓ vercel-install complete"
echo "    cargo:    $(command -v cargo)"
echo "    wasm-opt: $(command -v wasm-opt)"
echo "    vp:       $(command -v vp)"
echo "    node:     $(command -v node) ($(node --version))"
