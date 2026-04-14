# den

High-quality audio effects for the Web Audio API, compiled from Rust to WebAssembly.

## Status

Early foundation — see the [Foundation epic](https://github.com/yuichkun/den/issues/1).

## Quickstart (contributors)

```bash
# One-time: install Vite+ (CLI wrapping pnpm + Vite + Vitest + oxlint/oxfmt)
# macOS / Linux:
curl -fsSL https://vite.plus | bash
# Windows (PowerShell):
#   irm https://viteplus.dev/install.ps1 | iex

# Install deps (Vite+ reads pnpm-workspace.yaml + .node-version automatically)
vp install
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Build

`den-core` is a `#![no_std]` Rust crate that compiles to `wasm32-unknown-unknown` and is post-processed with `wasm-opt` (binaryen). The rest of the workspace is std Rust + TypeScript packages built with Vite+.

### Prerequisites

- Rust stable (managed by `rust-toolchain.toml`; the `wasm32-unknown-unknown` target installs automatically)
- `wasm-opt` from the `binaryen` package — must be on `PATH`:
  - macOS: `brew install binaryen`
  - Ubuntu/Debian: `sudo apt-get install -y binaryen`
- Vite+ (`vp` CLI) and Node 22 — installed via the Quickstart above

### Build everything

```bash
vp run build
```

This runs (in topological order across the workspace):

1. `packages/core/scripts/build-wasm.mjs` — `cargo build --target wasm32-unknown-unknown --profile wasm-release -p den-core`, then `wasm-opt -O3 ...` into `packages/core/dist/den_core.wasm`.
2. `packages/core` library bundle (TS loader + the WASM artifact placed beside it).
3. `packages/worklet` two-bundle build — main-thread ESM + classic IIFE worklet processor.
4. `packages/effects` library bundle.
5. `packages/test-utils` library bundle.

### Validate

```bash
# Rust — den-core is checked separately for its wasm32 target.
cargo fmt --all -- --check
cargo clippy --workspace --exclude den-core --all-targets -- -D warnings
cargo clippy -p den-core --target wasm32-unknown-unknown -- -D warnings
cargo check --workspace --exclude den-core --all-targets
cargo check -p den-core --target wasm32-unknown-unknown

# TypeScript / JS
vp check        # fmt + lint (+ typecheck if enabled in lint.options)
vp run smoke    # Node-side WASM smoke test (scripts/smoke.mjs)
```

## License

Dual-licensed under MIT or Apache-2.0.
