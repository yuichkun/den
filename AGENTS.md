# AGENTS.md

## About

`den` is a high-quality audio effects library for the Web Audio API,
compiled from Rust to WebAssembly and wrapped in AudioWorklet. Distributed
as `@denaudio/*` npm packages.

## Required tools

Install these before doing anything else.

| Tool | Version | Install |
|---|---|---|
| Rust (stable) | 1.85+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| rustfmt + clippy | — | `rustup component add rustfmt clippy` |
| binaryen (`wasm-opt`) | version_129 | `sudo apt-get install -y binaryen` (or `brew install binaryen`) |
| Vite+ (`vp` CLI) | latest | `curl -fsSL https://vite.plus \| bash` |
| Node.js | 22.x | managed by Vite+ via `.node-version` |
| pnpm | 10.33.0 | bundled with Vite+ (do not install separately) |

## Cursor Cloud specific instructions

### Environment notes

- The VM image ships with an older Rust (1.83). The update script runs
  `rustup update stable && rustup default stable` to pull 1.85+. After
  that, `wasm32-unknown-unknown`, `rustfmt`, and `clippy` are added
  for the new toolchain (they don't carry over from the old one).
- `wasm-opt` is installed from Ubuntu's `binaryen` package. The repo
  version field says `version_129` but Ubuntu noble ships 108, which
  works fine for optimising `.wasm` outputs.
- **Vite+** installs to `~/.vite-plus/bin/vp`. After installation you
  must `source ~/.bashrc` (or start a new shell) so `vp` is on `$PATH`.
  Node.js 22.x is managed via `vp env install 22 && vp env use 22`.
  pnpm is bundled with Vite+ — do not install it separately.
- To compile Rust to Wasm:
  `cargo build --target wasm32-unknown-unknown --release`
  then optimise with `wasm-opt -O3 <input>.wasm -o <output>.wasm`.
- Lint: `cargo clippy --target wasm32-unknown-unknown -- -D warnings`
- Format check: `cargo fmt --check`
