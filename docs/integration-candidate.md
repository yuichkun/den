# Mobile integration candidate

This branch combines audition `29daeff030b53670394893b4154ab9a06cc250ec`, filter
`5c087449fad2ea77756affa3e9231e4c544741e5`, delay
`7ef7ce670531b1230111f1d2c89302bfe44935b2`, and instrument
`baa4bd50f11d1561b0f52e2c6417970e563f7114`, plus the two delay settings from
`1fa26a69ed2d3fc10202c9fc465b2cb18dc40fd0`. It is not an instrument release or a
completed sound bank. The instrument runtime gate is not cleared, and physical
playback/listening remain unverified. This branch also follows approved main
`c65e2a8586eb0325cbccc3963af3764c7f15c926` (including PR20, PR23 and PR25).
Further main changes require corresponding integration verification. No registry publication or hosting change is included.

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
identity. These remain sound candidates: no golden promotion, physical browser
playback acceptance, or runtime clearance is recorded by this integration.

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
`npm run build:integration` packs den into the clean locked integration consumer
and stages its Vite output into `site-dist`. This candidate branch's `vercel.json`
selects that explicit build command; its root `/` serves the integration UI.
Production main retains its audition `build:consumer` command. Do not merge this
candidate branch into main or change the Vercel production branch/project settings.
Local delivery verification serves the exact staged output and exercises Start,
selection and Stop from that entrypoint. No deployment is performed by building.

This candidate is labeled INTEGRATION CANDIDATE without a privacy claim. A
nonproduction preview in the existing Vercel project is in scope after final
review and verification; this change does not push or deploy it, modify access
settings, or merge the instrument into main.

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
NOT_CLEARED and generated evidence remains CANDIDATE. Main and the production
branch/project settings remain unchanged.
