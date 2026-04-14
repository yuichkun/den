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

# Rust-side check
cargo check --workspace

# JS-side fmt + lint + typecheck (oxfmt + oxlint + tsc)
vp check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## License

Dual-licensed under MIT or Apache-2.0.
