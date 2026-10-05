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

## Try the initial candidate

`npm run build:site` writes the deployment to `site-dist/`:

- `/`: Diagnostic / Bass / Percussion / Pad with Diagnostic delay / Chorus / Rhythmic delay
- `/diagnostics.html`: silent package gain and snapshot check
- `/audition.html`: earlier Envelope/LFO diagnostic listening room
- `/catalog.html`: four new musical materials with complete A/B settings

Serve that directory over HTTP locally, or use the existing Vercel deployment.
Select a sound and effect while stopped, then press Start audio. Hold the keys
or the sound-specific hold button; Release leaves the tail, Clear resets notes
and delay history, and Stop closes audio. Start with low device volume. The
shared Master control is 0–1 with no normalization or limiter.

The site is a usable initial candidate, not a cleared general-release runtime.
Known intermittent frame-clock/underrun observations remain **NOT_CLEARED**.
Browser coverage is **48 kHz only**; 44.1/96 kHz offline success is not browser
support. Existing positive candidate listening feedback is recorded separately
from generated test output and exact-hash golden approval in the
[acceptance record](docs/initial-acceptance.md).

The [catalog audition](docs/catalog-audition.md) has its own explicit Start,
independent hold controls and visible unity-default master. Stop before changing
materials or A/B settings. These new candidates have no inherited listening approval.

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
manual lower-zone expression and musical-example candidates,
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
