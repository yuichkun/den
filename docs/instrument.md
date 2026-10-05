# MIDI instrument composition

`src/instrument.ts` composes the existing voice policy, oscillator, filter,
Envelope and LFO. `createInstrument(config)` returns an unworklet processor;
`instrument` is the diagnostic polyphonic default. There is no new MIDI,
parameter, routing, snapshot, loader or test framework.

The initial sound is **CANDIDATE**, not an approved golden or one of the eventual
bass/percussion/pad presets. Those sounds will use this same engine.

## Construction and replacement

Pass a required configuration to `createInstrument`:

- `mode`: `mono` or `poly`; `legato`, `capacity`, `heldCapacity` follow the voice
  policy. Mono uses one voice; poly defaults to 4. Engine capacity is currently
  limited to 16, held capacity to the underlying policy's 256. These are fixed
  construction/compilation bounds, not approved product-wide polyphony limits.
- `waveform`: `sine` (default) or `saw`, using the existing oscillator.
- `oscillator` and `filter`: optional compatible unworklet `defineSubgraph`
  declarations, with the same required config and `tick` signatures as the stock
  modules. Each is instantiated with separate named state for every voice.

`src/instrument-example.ts` demonstrates replacing both parts with custom
unworklet subgraphs: a half-level sine and backward-Euler one-pole low-pass.
The example is intentionally sine-only and its filter ignores resonance; it
illustrates a concrete replacement, not another full instrument or a quality
upgrade. Its amplitude/response is checked against independent formulas.

The processor uses unworklet's compile-time sample rate. Offline coverage is
44.1/48/96 kHz; the published 0.4.1 bundler/browser boundary remains 48 kHz.
The complete 16-voice graph compiles, but the initial real-time trace found
frequent deadline overruns at that capacity on the validation host. The engine
therefore starts at four voices; higher capacities require a device-specific
real-time budget check. A 32-voice probe produced a
11,614,744-byte process function before completion-expression materialization, exceeding WebAssembly's 7,654,321-byte function
limit. The first engine keeps a tested ceiling of 16 at construction;
16 voices with 256 held identities are tested. These checks establish compilation
and bounded rendering, not a mobile-device real-time CPU guarantee.

## Ports and musical controls

Use native `node.midi.midi.send(event)` for MIDI, `node.params.<name>` for
AudioParams, and `node.events.reset.emit({value:1})` for panic. Output `main` is
two identical channels. Mixing is linear, with no limiter, normalization or
voice-count attenuation; coherent voices can exceed unity. The diagnostic gain
is 0.15, and the browser fixture remains muted.

`diagnosticInstrumentParameters` is an ordinary initial AudioParam value map,
usable with unworklet's existing `createNode(..., {initial: ...})`. It is not a
separate preset/state format. All continuous controls are a-rate:

| Controls | Units / bounds |
| --- | --- |
| `gain` | Linear [0,1] |
| `ampAttack`, `ampDecay`, `ampRelease` | Seconds [0,30] |
| `ampSustain` | [0,1] |
| `pitchAttack`, `pitchDecay`, `pitchRelease`, `pitchSustain` | Same ADSR units |
| `filterAttack`, `filterDecay`, `filterRelease`, `filterSustain` | Same ADSR units |
| `cutoff`, `resonance` | Hz [20,20000], Q [0.5,10]; actual cutoff limited to 0.45×sample rate |
| `pitchEnvelopeDepth`, `lfoPitchDepth` | Semitones [-24,24] |
| `filterEnvelopeDepth`, `lfoFilterDepth` | Octaves [-8,8] |
| `lfoRate`, `lfoAmpDepth` | Hz [0,20], tremolo depth [0,1] |
| `bypass` | Values >=0.5 mute output |

Inputs must be finite and within their declared AudioParam domains. Automation
and any host smoothing use unworklet/Web Audio, not a den wrapper.

Each voice has three instances of the same linear ADSR. The amp envelope governs
voice lifetime: zero sustain does not free a held voice; release completion does.
Audio ends on the exact envelope sample. The allocator consumes completion once
at block end, before the next block-boundary MIDI dispatch; it does not perform
quadratic allocation-rank maintenance on every audio sample.
Pitch/filter envelopes may finish earlier or later but cannot keep an amp-silent
voice allocated. Retrigger/release starts from each envelope's current level.
Duration quantization, segment latching and zero-duration behavior are those of
`envelope.ts`; edits affect the next segment except sustain, which tracks while
held in the sustain stage.

One shared free-running LFO drives finite amp/pitch/filter destinations, with no
implicit note reset. For voice i:

- Frequency = MIDI equal-tempered A4=440 Hz × 2^(semitones/12), clamped to
  [0,0.45×sampleRate]. Semitones = pitch-envelope level × envelope depth + LFO ×
  LFO pitch depth, with the combined amount clamped to [-24,24].
- Cutoff = base cutoff × 2^octaves, then clamped to the filter bounds. Octaves =
  filter-envelope level × envelope depth + LFO × LFO filter depth; the combined
  amount is clamped to [-8,8].
- Amp = amp-envelope level × normalized MIDI velocity ×
  (1 - tremoloDepth × (1 - LFO)/2). Depth zero is unity; depth one spans [0,1].

Both pitch and filter depths are combined in their musical units **before** the
single final destination clamp. A constant 128-note tuning table supplies MIDI
base pitches; transcendental pitch ratios use the reviewed modulation module.

## Event order, reset and state

MIDI dispatch remains quantum-boundary FIFO in unworklet 0.4.1. Do not claim
sample-accurate MIDI. On/off pairs in one block can coalesce to no sound.
Duplicate identities, velocity-zero note-on, steal/release reuse and mono
last-held-note priority follow `voice-policy.ts`; CC64 is not implemented.

- A note/retrigger resets its oscillator phase and filter history, while its
  envelopes retrigger from their current levels. Mono legato leaves those states
  continuous. Hard stealing/retrigger can click; no listening approval implied.
- CC123 starts release for that channel. CC120 immediately frees its voices and
  clears their DSP states. If another note reuses a cleared slot in the same
  quantum, the clearing sample is silent and its attack begins next sample.
- `reset` wins over every MIDI event dispatched in the same quantum. It clears
  the held ledger, voice allocation, pending retriggers, envelopes, oscillators,
  filters and shared LFO. Output is immediately silent. Fresh notes in later
  quanta can start normally.
- Bypass mutes only the output. MIDI, phase, modulation and release continue; a
  held note reappears when unbypassed, while an ended release remains silent.
- Inactive slots clear their DSP histories. A new note cannot inherit a completed
  or panicked voice's tail. Live held-note state is transient: same-schema
  snapshots restored into a new node restore parameters/shared LFO but do not
  revive held voices. Inactive
  histories are cleared on the first rendered sample, including when a new note
  arrives in the first quantum after restore. That clearing sample is silent;
  the new note begins at phase zero on the next sample. A pristine instance
  needs no extra clearing sample. Native 0.4.1 **in-place** restore only overlays
  persistent slots: it does not initialize transient live voices. For a cold
  in-place restore, send the existing `reset` after restoring, render at least
  one quantum, then send fresh notes. Sending reset and fresh notes in the same
  quantum follows the documented reset-wins policy. No restore wrapper is added.
  Follow the existing
  rendered-parameter snapshot constraint; schema migration is not added.

## Verification and integration

`tests/instrument.spec.ts` uses an independent direct-form biquad plus analytic
sines for the complete signal path, direct closed-form envelopes for per-voice
release/retrigger, and frequency/cutoff probe replacements for modulation units.
It tests wrong-answer rejection, stereo equality, zero scrubbed samples,
polyphony, mono legato, steals, channel panic, reset, edits, bypass and snapshots.

The isolated packed fixture checks declarations/build, renders all three offline
rates, compiles the replacement example, and drives real 48 kHz browser MIDI and
AudioParams. It produces raw stereo float WAV, a fixed-scale waveform and a
manifest binding the exact source hashes/commit, package/lock, all diagnostic
parameters, MIDI, rates, seed and verification. No audio matcher/golden update or
FFT is used.

The public subpaths are `@denaudio/den/instrument` and
`@denaudio/den/instrument-example`. The isolated packed fixture imports the
replacement oscillator/filter example through that public boundary and renders
it at 48 kHz (the stock instrument is rendered at all three offline rates). It does not reach into package internals.

## Sustained real-time gate

The instrument-specific browser observer records twelve seconds of actual graph
output at 48 kHz, including four held A4 voices, note-offs and a one-second
release. Its fixed capture buffer is test instrumentation only. A sinusoid fit
from the initial steady window predicts the entire steady interval; a separate
first-difference bound detects discontinuities and the known release law
predicts the tail. A separate native `AudioBufferSourceNode` supplies an exactly
representable reference ramp to the observer's second input. The test requires
4,500 complete 128-sample blocks and exact ramp progression through all 576,000
samples, including the silent tail. Duplicate, dropped, reordered, zeroed and
short-block counterexamples verify the observation contract.

Published `currentFrame` entry/exit values and output timestamps remain in the
raw evidence. Repeated/skipped published frame values are reported separately
as `CLOCK_METADATA_ANOMALY_REQUIRES_REVIEW`: a hosted failing and passing capture
had byte-identical complete WAVs despite different frame metadata. Chromium's
worklet-scope clock publication can skip a lock-contended update; this mechanism
does not by itself establish the cause of an individual anomaly. Native ramp
progression and the independent audio oracle establish the captured graph's
sequence, not hardware continuity. The artifact retains `NOT_CLEARED`, the raw
WAV/reference data, waveform, native errors and timestamps. The expected 0.4.1
`sab-unavailable` notification is recorded; traps and queue/length errors fail.

Chrome audio trace is also collected to inspect per-quantum render durations.
Raw graph continuity alone cannot establish that the hardware output met its
real-time deadline. Neither this fixture nor offline correctness substitutes for
hardware-loopback/device testing or listening approval.

The trace report includes generated WASM sizes/hashes, wall and CPU render
durations, and counts above the 128-frame budget (2.667 ms). It excludes the
first second when reporting steady timing and tests the detector with an
explicit over-budget counterexample. Any observed steady wall-time overrun
sets `QUANTUM_OVERRUNS_REQUIRE_REVIEW`; passing numerical assertions does not
override this readiness finding. A four-voice measurement on the validation
host had median 0.344 ms, p99 0.992 ms, maximum 14.752 ms and 9 steady wall-time
overruns. Sixteen voices had median 1.447 ms, p99 4.583 ms and 221 overruns.
These are host-specific observations, not portable capacity guarantees. The
raw trace and each run's exact figures are preserved with the candidate WAV.

Bounded pitch/cutoff modulation signals and control predicates use existing
transient unworklet state, because expression reuse alone can expand the graph.
Oscillator output, filter output and amplitude-envelope level stay expressions:
native floating-point state writes flush magnitudes below 1e-30, which would
destroy finite tiny values recoverable by a later custom filter or gain.
No private memoization API, altered flush threshold or custom-value restriction
is used. Regression cases include subnormal input, large oscillator/tiny amp,
tiny filter output and signed zero observed by a replacement filter.
Transient layout changes are not a migration for snapshots from older revisions;
the snapshot contract remains identical processor/schema/rate only.
Voice completion is committed once per block after
sample processing; this avoids running allocator rank maintenance at audio rate
while preserving exact sample silence and availability at the next MIDI drain.
Shared DSP modules remain unchanged; the common expression-expansion/runtime
performance investigation is still outstanding.
