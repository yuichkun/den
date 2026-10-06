# Sustained audition deadline regression

The manual `node scripts/probe-realtime.mjs` command builds its own isolated
packed consumer before capture. It does not require or alter public `site-dist`,
and it does not restore the removed public audition page. The capture modes and
assertions below are unchanged.

The first browser tests proved sample values and lifecycle behavior, but did not prove that an AudioWorklet could produce those samples on time. In particular, waiting only for AudioContext time lets an overloaded renderer eventually finish and hides wall-clock drift. This gap allowed a numerically correct sustained sine to crackle during real playback.

## Reproduction and isolation

At reviewed frontend head `5d42072`, the audition compiled to 1,122,834 bytes of WASM. In this execution environment, warmed native WASM calls over 128-frame blocks measured a median 2.82 ms and p95 8.90 ms, exceeding the 48 kHz budget of 2.667 ms. A real Chromium capture took about 8.09 wall-clock seconds for five seconds of graph output and reported 839 playback underrun events. The raw graph samples remained continuous. Disabling waveform drawing did not remove the problem; a separate native sine context could render without underruns. The independent reviewer also reproduced excessive AudioWorklet process cost and phase-dependent stalls with depth zero.

This isolates a deadline failure in the composed DSP, rather than a phase reset in its sample sequence. The published 0.4.1 arithmetic emitter recursively emits child expressions; retaining a Node in a JavaScript variable does not materialize its computed value. The repeated polynomial/squaring expressions used by pitch modulation amplify the composed expression tree. Explicitly materializing the subgraph boundaries reduces emitted size and processing cost while preserving samples. This is a den composition fix, not an upstream patch or a claim that every compiler path has been audited.

The fix stores envelope level, LFO output and final pitch in three existing unworklet f32 transient state slots, then reads each later in the same sample. It adds no sample delay, custom state mechanism, preset or routing system. Each subgraph still ticks once per sample. The independent sine-times-envelope error remains 8.15e-8. WASM becomes 34,679 bytes; a warmed run measured p50 0.109 ms and p95 0.199 ms. These are measurements on this runner, not guarantees for every physical device or the future polyphonic instrument.

The final regression harness was also run against the unchanged `5d42072` audition source: its native control recorded zero underruns, while den windows recorded 589/588/594/592 events and took 6.1–6.4 seconds for five seconds of samples. It exited with `full: real-time underrun events` (589 != 0). Restoring the materialized source passed the same checks.

## Regression check

`tests/realtime/audition.test.mjs` builds an isolated packed production consumer and runs after the existing numerical and packed/browser tests, rather than competing with them for CPU. The packed test files run serially because each invokes the shared package prepack build; concurrent TypeScript writes can otherwise race tarball reads. It uses a test-only native AudioWorklet recorder with preallocated storage and no per-quantum allocations. The recorder does not replace the production DSP or transport.

Each capture warms the recorder for one audio-clock second, then collects 240,000 real-time samples (five seconds at 48 kHz). Conditions are: native sine reference, den held tone with UI, LFO modulation, repeated parameter changes, and UI drawing disabled. Existing audition tests separately cover touch release/cancel, repeated Start/Stop, unavailable contexts and asynchronous startup.

For every den window and its conservative delayed-observation interval, the test requires zero new playback underrun events and zero underrun duration, five seconds of output within 5.5 wall-clock seconds, no consecutive zero samples, bounded adjacent/quantum-boundary steps, and a fitted 220 Hz sine residual below 1e-6 for unmodulated windows. Native oscillator results are recorded as an environment control; its implementation is not den's numerical contract. A warmed 1,000-block native WASM cost probe additionally requires p95 below half the quantum budget. Unsupported playback statistics fail the test instead of silently substituting offline evidence.

Raw capture precedes device fallback, so continuous samples alone cannot rule out crackling. `AudioContext.playbackStats` checks that separate playback layer. Recorder allocations initially caused small measurement artifacts, and native controls sometimes exposed host scheduling noise; the committed recorder avoids per-block array views. Neither existing sample tolerances nor expected audio have been relaxed.

`artifacts/realtime/current` is cleared at test start and holds fresh raw f32 files, actual browser version, playback statistics, wall/audio timing, continuity results and source/audio hashes. Each completed window is saved immediately; the manifest is written before assertions and on failure, including capture errors. CI uploads the scoped artifacts directory even when checks fail. A Node-side 15-second bound on each capture ensures a stalled worklet reaches teardown. The capture endpoint is taken on buffer reception before converting samples to a JavaScript array; conversion time and post-conversion statistics are recorded separately for both native and den windows. Immediate counter snapshots are not treated as final evidence. It is CANDIDATE evidence, never an approved golden. The unchanged production transport remains unworklet's postMessage fallback where cross-origin isolation is absent; no headers, protection settings, permissions or credentials change. Stop still closes the context, consistent with the risk described in upstream #81; each build runs in a fresh process, avoiding the repeated-build cache scenario in #101. Those reports are not being claimed as newly reproduced here.

Physical iOS/Android playback and human listening still require verification. This regression covers Chromium's actual 48 kHz real-time path and does not establish 44.1 kHz browser support or full-instrument CPU capacity.

## Materialization contract limits

All existing AudioParam declarations, names, ranges and automation rates are unchanged. Each new scratch slot is f32, transient and unpublished; the envelope/LFO/oscillator persistent slots retain their names and types. Writes precede reads within the same sample and every scratch value is overwritten before use, including after restoration. A separate dynamic probe changed frequency, rate and depth, then released the envelope: old/fixed PCM and split-render same-schema continuation were bit-identical. Snapshot inspection excluded all three scratch slots.

Transient declarations still change unworklet's schema hash: `31f5b44c3627df618038170d9b2af9be` becomes `34898cbf87b8f22e8754fff7b664da5d`. Version 0.4.1 falls back to name-matched restoration when no migration exists; this specific old-to-new continuation also matched exactly, but arbitrary cross-schema compatibility remains unsupported by den's entry contract. No preset migration framework is added.

This technique is not a blanket rewrite rule for arbitrary subgraphs: moving a read across a state write can change semantics, storing f64 intermediates into f32 loses precision, and existing unworklet state stores flush magnitudes below 1e-30 to zero. Here the materialized boundaries already return f32, with the audition's bounded normal-range controls. Future instrument/filter/delay compositions must establish their own ordering, precision, restoration and real-time evidence. The modules themselves are unchanged.

## Remaining sporadic browser underruns

The sustained old-graph overload is reproducibly removed, but some local Chromium runs still report isolated playback underruns. Raw captured samples remain continuous; that does not disprove playback-layer fallback. A fixed three-round native/den × recorder/no-recorder comparison had no underruns or container CPU throttling, and a separate traced run had GC activity without underruns. Conversely, a later capture using the pre-conversion endpoint recorded five native-reference events and one den held-tone event, with unchanged immediate counter snapshots across array conversion. Because counters update asynchronously, those snapshots cannot exclude events reported later. These observations do not establish a browser-version, GC, recorder or host-scheduling cause. Preserve failed runs alongside successful CI evidence; do not waive the zero-underrun assertion or infer universal device clearance.

## Delayed playback statistics

The [Web Audio stats update algorithm](https://webaudio.github.io/web-audio-api/#updating-the-stats) updates counters once per second while running and visible. Reading them only at buffer delivery can miss a terminal underrun. The harness keeps the context running, polls every 100 ms, and requires `totalDuration - underrunDuration >= captureEndAudioTime`, after at least 1.25 seconds of observation. Observation is bounded at four seconds; stale or unavailable counters fail with the complete poll history saved. The outer 15-second capture deadline still bounds stalled page/worklet execution.

The raw sample/wall-time window remains five seconds. The zero-underrun assertion conservatively includes the interval from the baseline's last reported counters through the delayed final counters; this may include pre-capture reporting lag and post-capture rendering/result handling. No late event is automatically attributed to conversion or discarded. Every observation retains wall time, audio time, covered audio time, visibility and counters.

A test-only 100 ms stall on the final recorded quantum of a native sine produced zero immediate events but nine delayed events (0.09018 seconds) in the local probe. The counterexample uses the same observation logic and requires the normal zero-underrun assertion to reject the capture. Fault audio is labeled separately from candidate audio. Passing earlier immediate-only checks does not establish end-of-window playback correctness.

## Independent LFO frequency assertion

The LFO capture also measures positive zero-crossing periods. An independent
least-squares fit of log-frequency against 4 Hz sine/cosine bases verifies the
0.5-semitone modulation depth, carrier and residual while allowing arbitrary LFO
phase at capture start. A plain 220 Hz signal cannot pass. The offline packed
fixture applies the same oracle to nonzero depth and requires zero depth to be
rejected. Disabling depth in a separate copy of the audition composition makes
that packed render fail specifically at the pitch-depth assertion. This adds a
numerical check without changing DSP, continuity thresholds or expected audio.
