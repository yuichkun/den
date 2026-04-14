#!/usr/bin/env bash
set -euo pipefail

# Vercel build env is Amazon Linux 2023; none of our toolchain is
# pre-installed. We install everything the build needs, idempotently.

# --- Rust + wasm32 target ---
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown
fi
# shellcheck disable=SC1090
. "$HOME/.cargo/env"

# --- binaryen (wasm-opt) ---
# Vercel's build env is Amazon Linux 2023 (glibc 2.34); the upstream
# binaryen Linux tarball is built against an older glibc and may load
# fine, but we've observed dynamic-linker mismatches in practice. Build
# from source as the primary path (cmake is preinstalled on Vercel's
# image; ~30s extra build time, deterministic, no glibc surprises). The
# tarball is a documented fallback only (issue #4 §8 Fallback #2).
BINARYEN_VERSION="version_129"
if ! command -v wasm-opt >/dev/null; then
  mkdir -p "$HOME/.local"
  if command -v cmake >/dev/null; then
    BUILD_DIR="$(mktemp -d)"
    git clone --depth 1 --branch "${BINARYEN_VERSION}" \
      https://github.com/WebAssembly/binaryen.git "$BUILD_DIR"
    cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" \
      -DBUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$HOME/.local"
    cmake --build "$BUILD_DIR/build" --target wasm-opt --parallel
    cmake --install "$BUILD_DIR/build" --component wasm-opt 2>/dev/null \
      || cp "$BUILD_DIR/build/bin/wasm-opt" "$HOME/.local/bin/"
    rm -rf "$BUILD_DIR"
  else
    echo "cmake unavailable; falling back to prebuilt binaryen tarball" >&2
    curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
      | tar xz -C "$HOME/.local" --strip-components=1
  fi
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# --- Vite+ (official install script per https://github.com/voidzero-dev/vite-plus) ---
if ! command -v vp >/dev/null; then
  curl -fsSL https://vite.plus | bash
fi
export PATH="$HOME/.local/bin:$PATH"

# --- Install workspace deps (Vite+ wraps pnpm; uses .node-version + pnpm-workspace.yaml) ---
vp install --frozen-lockfile

echo "✓ vercel-install complete"
