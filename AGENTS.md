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
