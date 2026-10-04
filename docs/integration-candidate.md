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

This one diagnostic uses four sine voices, engine gain 0.05, fixed 1 kHz/Q=0.5
low-pass, no pitch/filter/LFO depth, and 10 ms attack/200 ms release. The UI exposes
note/chord holds, an effect selector, delay mix, feedback (0–0.5), and output volume (0–0.1,
default 0.035). Diagnostic delay taps are fixed at 125/187.5 ms, with one-second
allocation. Chorus and rhythmic delay use the exported GEN-621 constants
unchanged: chorus has flat feedback tone, 18 ms taps with 0.65 Hz/3 ms modulation,
and defaults to feedback 0/mix .45; rhythmic delay uses 120 BPM dotted-eighth/
quarter taps, 3.2 kHz feedback low-pass, feedback .48/mix .35. Both allocate two
seconds. Selection is disabled during loading, playback and teardown; changing
while stopped sets the candidate defaults, and the next Start creates its
processor. No live topology or preset framework is introduced.
At most four active voices contribute. For this fixed positive low-pass response,
a .2 voice-sum bound and feedback ≤.5 give a .4 delay bound before the .1 master,
or .04 absolute peak (apart from floating rounding). Tests inspect every sample
of both channels for musical chords and coherent maximum-velocity four-voice
input at maximum feedback and master; RMS alone is not an acceptance criterion.
The same bound covers flat tone with convex interpolated taps and the fixed
Q=.5 feedback low-pass of the two settings. Tests compare each adapter with the
existing independent GEN-621 reference for both chords at default settings and
maximum feedback/full wet, and save a candidate WAV for each setting.
This bound is for these restricted settings, not arbitrary engine replacements.
The displayed analyser monitor is mono; stereo peak assertions use both channels.

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
