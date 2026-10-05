# Mobile integration candidate

The initial integration candidate is based on reviewed candidate
`196a1c3ef0e8eda9a007a2474c9d06f7f654acfa` (PR26, including PR28/PR29)
and main `9fd730bf9afb786edaae808d41208904fb3c844d`. This integration completes
public subpath access and the permanent packed-site build without changing DSP,
settings or dependencies. It is not a registry release or a real-time clearance.

The owner supplied positive feedback on the three dry sounds and the integrated
sound/FX preview on 2026-10-05. That candidate listening feedback is recorded in
[the acceptance record](initial-acceptance.md). No identical listening request is
pending. Exact-hash golden promotion remains separate; general physical-device
stability and the instrument runtime gate remain NOT_CLEARED.

The isolated `tests/integration-consumer` imports the public `./instrument` and
`./delay-fx` and `./delay-settings` subpaths from the installed package. The instrument is a processor;
the delay uses a small processor adapter around the existing subgraph. Its stereo
Web Audio path is MIDI → instrument → delay → master gain → analyser → destination.
MIDI remains the existing unworklet quantum-boundary interface. No new MIDI,
parameter, snapshot, serialization, routing or preset framework is introduced.

The sound selector offers Diagnostic, Bass, Percussion and Pad. The three sound
candidates are the unchanged public `createInstrument` configurations and all 22
native parameters from PR28, merged into this candidate branch at
`e87e51f25052d0ad474efe1a928f80908cf3bcaf`. Source SHA-256 checks pin their audio
identity. These remain sound candidates: no golden promotion or general runtime clearance
is recorded by this integration. Existing candidate listening feedback is retained
separately from machine-generated evidence.

Diagnostic retains four sine voices, gain .05, fixed 1 kHz/Q=.5 low-pass and
10 ms attack/200 ms release. Bass is mono last-held legato and Percussion mono
retriggered; both show low-register keys and a single C2 hold/trigger button.
Their controls do not promise a chord. Pad has four saw voices with a slow
attack/release, and C3/G3/C4/E4 keys plus their chord. Every selector is disabled
during loading, playback and teardown. Active synthetic changes are ignored,
without resetting held notes, parameters or the graph. Stopped sound selection
updates the labels/notes only; Start creates the selected public processor with
its exact native initial parameters. FX selection restores that FX's mix and
feedback defaults.

The stereo effects remain Diagnostic delay, Chorus and Rhythmic delay.
Diagnostic taps are 125/187.5 ms with one-second allocation. Chorus and rhythmic
use the exported GEN-621 constants: 18 ms chorus taps with .65 Hz/3 ms modulation
and feedback 0/mix .45; rhythmic uses 120 BPM dotted-eighth/quarter taps, 3.2 kHz
feedback low-pass and feedback .48/mix .35. Both allocate two seconds. Feedback
is limited to 0–.5 and wet mix to 0–1. No effect was added.

Output gain now spans 0–1, default 1. The previous diagnostic-only 2× ceiling
was reduced visibly in the UI because its .8 bound cannot be transferred to
saw/modulated sources. All raw instrument parameters and gain values remain
unchanged; there is no normalization, limiter or hidden per-sound compensation.
See [the sound/FX headroom evidence](sound-audition-headroom.md) for the distinct
bounds and measured 4×3 matrix. Both stereo channels must be finite, unscrubbed,
unclipped and within the explicit fixture bounds. The analyser display remains
a mono monitor with fixed −1 to +1 scale.

Start unlocks a fresh 48 kHz AudioContext in a real gesture. Holds may begin during
asynchronous loading and retain their latest intent. Release sends note-offs and
allows the delay tail to decay. Clear sends the existing instrument reset and a
delay-adapter reset event. Stop fades master gain for 20 ms, disposes both nodes,
and closes the context. Partial startup failure/cancellation cannot connect a
late node. Hidden-page teardown and touch/keyboard cancellation are retained.

Run `CHROMIUM_PATH=/usr/bin/chromium node --test tests/integration.test.mjs` on a
host with that browser, or omit the variable for the pinned Playwright browser.
The fixture uses the existing pack/install/build helper, a separate locked
consumer, independent analytic/direct-form references, and browser taps of the
actual connected instrument/FX outputs. It retains candidate WAV, settings,
source/package/WASM hashes, every numerical peak, browser results and failures
under `artifacts/integration`. Generated evidence is never an approved golden.
`npm run build:integration` produces a standalone integration-only local build.
The permanent `npm run build:site` route packs the same source into two clean
locked consumers and stages their checked assets into `site-dist`: integration
at `/`, the silent gate at `/diagnostics.html`, and the earlier Envelope/LFO
module audition at `/audition.html`. Both package integrities must match and
conflicting asset names fail the build. Vercel uses this versioned `build:site`
command, not a branch-only build override. Building does not itself deploy.

`tests/site.test.mjs` serves the staged deployment bytes and verifies both
selected sound/FX graphs, the silent gain/snapshot gate, preserved audition,
fresh navigation, and missing-asset/page-error absence. The full matrix and
interrupted/repeated lifecycle checks remain in `tests/integration.test.mjs`.
No production branch/project, authentication, access, or header setting change
is needed. Merge and deployment follow independent review and exact-head CI.

The packed and realtime browser gates use Vite preview with `configFile:false`,
without COOP/COEP headers. The integration manifest records response isolation
headers, `crossOriginIsolated`, SharedArrayBuffer availability, and the actual
transport passed to each native AudioWorkletNode. Both instrument and delay are
verified using `postMessage`. `vercel.json` does not configure isolation headers;
production browser observation reported the same fallback warning. Direct public
response-header inspection from this workspace was blocked by the network proxy
(CONNECT 403), so upstream hosting/proxy headers are not independently verified.
This establishes fallback coverage, not identical phone scheduling or physical
audio behavior. No hosting/header settings are changed.

## Verification coverage

The packed numerical matrix covers all four sounds and three FX at dry, default,
and maximum wet/feedback. Poly cases include coherent four-voice stress; Pad
runs beyond a full slow-LFO cycle. Existing independent diagnostic oscillator,
filter and delay references remain, and the new matrix compares each FX against
an independent per-sample reference using its actual input.

Packed browser checks exercise all twelve selected graphs, all 22 native initial
parameters, mono/poly note labels, stopped-only selectors, no autoplay, mobile
layout, default/dry/max-wet-feedback stereo peaks, mute, release, reset and clean
restart. Existing startup-failure, partial-load cancellation, touch cancellation,
keyboard renewal, context cleanup, and 15 ms target/20 ms Stop-fade checks remain.
Screenshots and measurement JSON are retained with candidate artifacts. Browser
CI is required; a local numerical pass is not a browser pass. Runtime remains
NOT_CLEARED and generated evidence remains CANDIDATE. Production branch/project
settings are unchanged; merging this reviewed build configuration deploys the
initial candidate through the existing Vercel integration.
