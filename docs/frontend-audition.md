# Mobile listening room

`/audition.html` is the first audible candidate in the existing Vercel consumer. The home page retains its silent entry check and links to the listening room. Build with `npm run build:consumer`; both pages come from a clean installation of the packed package, with the consumer lock's candidate integrity updated by the existing build helper.

The composition uses public `@denaudio/den/envelope`, `/lfo`, and `/oscillator` subpaths. It is one sine oscillator, one linear envelope, and pitch modulation via the existing LFO/depth function. Native unworklet AudioParams carry control changes. It is a module audition, not the full configurable MIDI instrument or delay FX. The branch includes oscillator dependency PR #18 at a8c73ac until that dependency is merged; envelope/LFO are from merged PR #17. Delay/voice work is deliberately outside this first frontend slice.

Start creates and resumes a 48 kHz context in the user gesture. Release lowers the envelope gate; Stop fades the native master gain for 20 ms, disposes the node and closes the context. Pointer capture handles finger release/cancellation, keyboard Space/Enter supports the pad, and page hiding stops audio. A start cancelled during asynchronous worklet installation cannot reconnect its node. No microphone is requested.

Output gain defaults to 0.035 and the control caps it at 0.1. This limits digital amplitude, not device sound pressure. The page tells listeners to begin with low device volume. The waveform samples output after this gain and displays it enlarged four times. The page exposes exact composition source, current settings, candidate status and three listening checkpoints. No click or playback action constitutes listening approval.

## Verification

`tests/audition.test.mjs` packs into an isolated consumer, typechecks public imports, production-builds both pages, renders the actual audition processor against an independent sine-times-linear-envelope formula at 48 kHz, and launches Chromium without an autoplay bypass. A 390×844 touch viewport verifies gesture start, output bounds, volume-zero silence, envelope-release silence, repeated Start/Stop, cancelled touch, startup cancellation, context closure and absence of page errors. Native analyser readings are checked independently of the UI status. Physical iOS/Android behavior still needs device listening; touch emulation does not establish that coverage.

Candidate WAV, source/audio hashes, settings, browser results and mobile screenshots are written under `artifacts/audition`. Existing browser validation remains 48 kHz; known 44.1/96 kHz baked-rate rejections remain expected entry-gate checks. No expected audio is changed and no approved golden is introduced.
