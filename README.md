# den

Composable DSP modules, one MIDI instrument engine and one stereo Delay FX
engine built on unworklet. The initial candidate includes Bass, Percussion and
Pad from the same instrument, plus Chorus and Rhythmic delay settings from the
same Delay engine. Audio remains **CANDIDATE**, not an approved golden.

## Setup and verification

Use Node **24.19.0** (npm **11.9.0**). No Rust, Cargo, wasm-pack, Vite+, or external
WASM compiler is required. Binaryen comes from unworklet.

```sh
npm ci
npm exec -- playwright install --with-deps chromium
npm run check
npm test
npm run build:site
```

With an existing Chromium installation, use `CHROMIUM_PATH=/usr/bin/chromium npm test`.
The tests build declarations/ESM, run independent numerical references, pack the
package, install it in clean locked consumers, build actual worklet/WASM assets,
and exercise real browser MIDI, AudioParams, snapshots and UI lifecycle. Generated
source/audio/waveform manifests and failures are retained in `artifacts/`; CI
uploads them. No command publishes to a registry.

## Code playground

`npm run build:site` packs the current den source into an isolated consumer and
builds the English TypeScript playground at `/`. Its Monaco editor resolves real
package declarations for completion, hover, signatures and diagnostics. Every
public import has an editable audio example. Run compiles in a cancellable
worker, creates a native node, and exposes its AudioParams; Stop disposes it.
See the [source format and host contract](https://github.com/yuichkun/den/blob/3042e73435986fa2804f5811604e784d93470c1f/playground/README.md).

The earlier public website was deleted before this replacement. Old
`catalog.html`, `audition.html`, `diagnostics.html` and `playground.html` routes
stay absent. Historical browser surfaces exist only as isolated test fixtures;
their canonical audio, MIDI, snapshot and interrupted-lifecycle gates remain.
See [deployment status](docs/deployment-status.md).

This replacement is under review. Generated audio remains **CANDIDATE**;
passing tests is not listening approval or all-device real-time acceptance.
See the [acceptance record](docs/initial-acceptance.md).

## Public package boundary

The ESM-only `@denaudio/den` requires **@unworklet/core 0.4.1** as a peer. All
exercised compiler, renderer, plugin and test dependencies are locked. Import
editable construction functions/subgraphs through these public subpaths:

- `@denaudio/den/envelope`, `/lfo`, `/filter`, `/oscillator`, `/voice-policy`
- `@denaudio/den/instrument`: `createInstrument`, diagnostic processor and the three sound settings
- `@denaudio/den/instrument-example`: custom oscillator/filter replacement example
- `@denaudio/den/delay-readhead`, `/delay-fx`, `/delay-settings`
- `@denaudio/den` and `/gate`: minimal composition and package diagnostics

```ts
import { createInstrument, bassConfig, bassParameters } from '@denaudio/den/instrument';
// Re-export this processor from a consumer module imported with ?worklet.
export default createInstrument(bassConfig);
// Pass bassParameters as createNode's initial AudioParam map.
```

Use the existing `@unworklet/unplugin` Vite plugin and `createNode`; den adds no
loader, parameter, MIDI, routing, snapshot or serialization framework. Settings
are plain engine construction options and complete native parameter maps.
Snapshots require the same processor/schema/sample rate. See the
[instrument contract](docs/instrument.md), [sound settings](docs/instrument-settings.md),
[Delay FX contract](docs/delay-fx.md), [effect settings](docs/delay-settings.md),
[shared contracts](docs/contracts.md), and [dependency limitations](docs/dependency-findings.md).

## Extended catalog candidates

The [catalog coverage record](docs/catalog-status.md) lists additive clean filter/EQ,
formant/crossover, dynamics, drive/reduction, modulation/reverb, source/resonator
control/sequence/arpeggiator, sample/granular, wavetable/VA, sustain/expression
bounded spectral/convolution, character/frequency-shift, limiter/multiband,
editable-curve, fixed oversampling, dual-head delay, windowed pitch-shift,
manual lower-zone expression, framewise spectral gate, prepared convolution,
crossfaded loops, bounded native take recording, rolling accepted-write history and live grains, freeze/thaw tails, experimental resident WSOLA, musical pitch quantization, bin-centered spectral freeze, frequency-magnitude blur, gain-capped cross-synthesis, fixed filter-bank vocoder, segment-relative curved envelopes and tempo multiwave LFOs, hybrid spatial chains with feedforward pitched tails and musical-example candidates,
with their public imports, independent tests and remaining work. These modules
have separate acceptance evidence; the initial five sounds' feedback does not
approve new audio automatically.

## Evidence and scope

The [integration notes](docs/integration-candidate.md) describe lifecycle and
4×3 sound/FX coverage; [headroom evidence](docs/sound-audition-headroom.md) records
the bounded fixed-input measurements. [Deployment](docs/deployment-status.md)
uses the same packed consumers as the tests. Candidate audio has independent
numerical assertions and source/settings/input/audio/static-waveform manifests.
Golden promotion requires human approval tied to exact source/audio hashes in
a separate change. CI success does not supply that approval.

This is a fresh TS/unworklet implementation. The retired Rust/WASM contents are
preserved only in Git history. MIT/Apache-2.0 notices and attribution remain.
Package version is `0.0.0`; no registry release is intended.
