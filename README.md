# den

Composable DSP modules and instrument/effect engines built on unworklet. This
branch establishes the package entry gate; the MIDI instrument and delay FX are
not implemented yet.

## Setup and verification

Use Node **24.19.0** (npm **11.9.0**). No Rust, Cargo, wasm-pack, Vite+, or external
WASM compiler installation is required. Binaryen comes from unworklet.

```sh
npm ci
npm exec -- playwright install --with-deps chromium
npm run check
npm test
```

In a restricted environment with an existing Chromium installation:

```sh
npm ci --cache /tmp/den-npm-cache
CHROMIUM_PATH=/usr/bin/chromium npm test
```

`npm test` builds the declarations/ESM, runs numerical and dependency probes, packs
the package, and installs that tarball in a fresh OS temporary directory with its
own locked dependencies. It checks a strict TypeScript consumer, performs a Vite
production build using unworklet's plugin, renders offline, and exercises real
Chromium AudioParams and snapshots. The browser is silent (a zero-gain sink).
The temporary consumer is retained for diagnosis. Test output goes to ignored
`artifacts/`; CI uploads it. No command publishes to a registry.

## Package boundary

The ESM-only `@denaudio/den` package exposes `gateCell`, a representative editable
TypeScript subgraph. `@denaudio/den/gate` exposes `gate`, a mono one-sample memory
and gain fixture. Neither is a production oscillator, envelope, or delay engine.
The package requires **@unworklet/core 0.4.1** as a peer. The checked-in lockfiles
pin the exercised compiler, renderer, plugin, and test dependencies.

```ts
import { gateCell } from '@denaudio/den';
import { instantiate } from '@unworklet/core';
// Within a defineProcessor declaration body:
const cell = instantiate(gateCell, { scale: 1 }, { name: 'cell' });
// Within forSample: cell.tick(inputSample, gainSample)
```

For the browser, re-export `gate` from a consumer processor module and import
that module with `?worklet`; use the existing `@unworklet/unplugin` Vite plugin and
`createNode`. See [the clean consumer](tests/consumer). No den loader is needed.
This gate exercises explicit TS subgraphs, not `.uwk` sugar or browser HMR.

Read [lane contracts](docs/contracts.md) before starting dependent DSP work, and
[dependency findings](docs/dependency-findings.md) before relying on snapshots or
helpers. The contract requires independent review before parallel DSP integration.

## Audio evidence

The gate produces float WAV candidates, static waveform plots, snapshots, and a
manifest linking source commit/hashes, package and lockfile hashes, settings,
input, rates, and verification. These are **CANDIDATE**, not human-approved audio
or golden baselines. This fixture has no musical quality claim. Golden promotion
requires hearing approval tied to exact source/audio hashes in a separate change.

## Repository transition

This is a fresh TS/unworklet foundation. The retired Rust/WASM implementation,
legacy packages, documentation, scripts, and configuration are removed in this
branch's diff; their history remains in Git. Existing MIT/Apache-2.0 legal texts
and contributor attribution are retained as license notices, not implementation.
The public package is currently version `0.0.0`; no registry release is intended.
