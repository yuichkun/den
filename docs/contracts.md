# Entry contract for parallel DSP work

This document preserves the original G0 entry proposals and their provisional
bounds. It is historical design context, not a statement that only the gate exists
or that later public exports are unavailable. Current module contracts and the
implemented initial package/site boundary are linked from [the README](../README.md)
and [the acceptance record](initial-acceptance.md). Later reviewed module-specific
contracts supersede the provisional choices below.

## Authority and provisional choices

The approved initial-scope specification says that individual DSP methods and
numeric upper bounds are not yet determined. GEN-610 asks the entry work to make
those boundaries concrete for review; it does not approve a particular voice
count, delay capacity, filter law, or musical behavior.

The numbers and engine policies below are **provisional implementation proposals**,
not user-approved product limits or tested defaults. In particular:

- **16 voice slots** is a candidate starting capacity for testing chord overlap,
  release reuse, and deterministic stealing. It is not derived from a measured
  CPU/memory budget. GEN-616 must select/benchmark capacity and expose it as fixed
  construction configuration, rather than assuming 16 is a product-wide ceiling.
- **Two seconds per delay channel** is a candidate starting allocation for short
  effects and delay fixtures. At 96 kHz, stereo f32 buffers with two guard samples
  use 1,536,016 bytes. This is not a validated product memory budget. A whole note
  at 30 BPM requires eight seconds, so the candidate capacity does not cover all
  rhythmic settings. GEN-615/GEN-620 must jointly choose capacity and explicit
  out-of-capacity behavior; silent tempo-time clamping is not accepted as correct
  rhythmic playback. Keep maximum delay as fixed construction configuration.
- All other stated ranges, signal shapes, voice priorities, interpolation,
  feedback/mix, and bypass policies have the same provisional status. Later lanes
  must validate or revise them with independent numerical evidence and review.
  Review-approved code decisions still do not imply human sound approval.

The gate proves only the public package/subgraph boundary, mono one-sample memory,
linear gain [0,1], actual parameter edits, and same-schema snapshot continuation.
It contains no 16-voice allocation or two-second delay implementation. DSP lanes
can propose revisions without seeking a new product decision for every engineering
choice, but must coordinate changes that affect shared consumers/contracts.

## Composition and state

- One ESM package, `@denaudio/den`; current exports are `gateCell` at the root and
  `gate` at `/gate`. Subsequent module exports require integration review.
- Reusable DSP is an existing `defineSubgraph` declaration. Use required config
  arguments (no default parameter), and `instantiate(unit, config, {name})` with
  stable, unique instance names. Audio-rate inputs/outputs use unworklet
  `Node<'f32'>`; boolean controls use `Node<'bool'>`. No custom graph or routing API.
- Configuration is immutable per instantiation: sample rate, fixed capacities,
  selected DSP mode. Continuous controls use existing a-rate AudioParams and
  graph inputs. No den parameter registry or preset format.
- Internal phase, history, and buffers use unworklet state. Persistent slots have
  stable names/types; use existing snapshot profiles, codec, and migration APIs.
  Gate restoration is verified only for the identical processor/schema and rate.
  Never treat same byte width as type compatibility (#79). A schema change needs
  an explicit reviewed migration and its own tests before old snapshots are used.
- Native transient state is excluded from snapshots, not automatically reset by
  an in-place restore. Fresh-driver offline restore starts from declaration
  defaults; browser `node.restore()` leaves current excluded notes/controllers
  unchanged. A cold live restore requires the composition's explicit reset,
  followed by a rendered quantum before fresh notes. Do not infer live clearing
  from fresh-instance offline evidence.
- Save after AudioParam edits have actually rendered, while controls are stable
  (#78). A suspended snapshot is not a reliable capture of pending edits in 0.4.1.
  This gate does not solve suspended preset editing or in-flight automation recall.
- Worklet compilation is sample-rate-specific. Offline rendering is verified at
  44100, 48000, and 96000 Hz, with 128-frame quanta. The existing 0.4.1 Vite plugin
  compiles at 48000 and exposes no sample-rate option; real browser contexts at
  44100/96000 are verified to reject creation. Browser rendering is proven only
  at 48000. Non-48-kHz browser loading remains an upstream limitation, not a requirement
  of this entry gate and not a blocker for den development. Do not bypass the
  mismatch guard or claim multi-rate browser readiness. The supported browser
  scope is explicitly 48 kHz; offline multi-rate coverage is separate.
- State allocation is fixed at graph creation. No dynamic audio-thread allocation.
  Reset uses existing node/event control, clears histories/voices/phase immediately
  at its dispatched sample, and may create a discontinuity. Reset is not bypass.

## Module boundaries and provisional defaults

| Lane | Graph boundary and units | Proposed policy for first integration |
| --- | --- | --- |
| Envelope (GEN-611) | Gate/retrigger → normalized unipolar level [0,1] and completion flag. Attack/decay/release seconds [0,30], sustain [0,1]. | One state per voice/use; zero time is instantaneous. Retrigger from current level; note-off releases from current level. Completion only when release reaches zero. Lane selects/documents curve law; no second envelope engine for pitch/filter. |
| LFO/modulation (GEN-614) | Rate Hz [0,20], phase cycles [0,1), reset → bipolar unit signal [-1,1]. Depth is applied at the destination in its own units. | Rate 0 holds phase. Free-running or explicit phase reset; no implicit note reset. First shape sine; further shapes need lane tests. Pitch depth semitones [-24,24], cutoff depth octaves [-8,8], delay depth seconds [0,0.05]. Clamp the composed destination to its bounds. |
| Filter (GEN-612) | Mono normalized audio → mono audio; cutoff Hz [20,min(20000,0.45×sampleRate)], resonance Q [0.5,10]. | One low-pass method selected and justified by this lane. Independent state per voice/channel. Reset clears history. No hidden gain normalization; response/peak bounds must be established before integration. |
| Voice policy (GEN-616) | Existing MIDI events → per-voice note, gate/retrigger, velocity [0,1], release completion. | Candidate default 16 slots, fixed per construction; mono uses one. Mono last-note priority, legato preserves envelopes until an explicit retrigger. Poly reuse free, then oldest releasing, then oldest active voice; deterministic slot-index tie break. Duplicate note-ons allocate separately; note-off releases oldest matching active channel/note. Velocity-zero note-on means note-off. Completion returns a voice to free; reset/all-sound-off clears all. |
| Oscillator (GEN-613) | Frequency Hz [0,0.45×sampleRate], phase reset → mono signal nominally [-1,1]. | Per-voice phase cycles [0,1); rate 0 holds. MIDI tuning A4=440 Hz, equal temperament. Lane selects one band-limited method and documents alias/level limits. Reset phase 0. No new MIDI receiver. |
| Delay read-head (GEN-615) | Mono input and delay seconds [1/sampleRate,2] → delayed mono output. Two independent instances form stereo FX. | Candidate allocation ceil(maxDelaySeconds×sampleRate)+2 samples per channel, initially proposing maxDelaySeconds=2; no resizing. Linear fractional interpolation with wrapped adjacent reads. Continuous moving head (Doppler behavior), not dual-head crossfade. Clamp time after modulation; reset clears buffer and pointers. |

Methods and exported types for unfinished modules are deliberately not stubbed:
use each lane's own tested unworklet subgraph with reviewed boundaries, then bring
public exports through integration review. `tests/consumer/contract.ts` demonstrates
composition from the packed public entry. The small gate's actual `tick(input,
gain)` is solely a packaging example, not an imposed interface for every module.

## Engine integration targets

One instrument: existing MIDI input `midi`, stereo audio output `main`, mono DSP
per voice feeding equal L/R initially; amp and velocity gains are linear, no
limiter or automatic loudness normalization. Mono/poly is immutable configuration
for the first engine. Voice stealing hard-retriggers from current envelope level;
its click behavior needs numerical and listening evidence before sound approval.

One stereo delay: audio input/output `main`; mono callers duplicate L/R explicitly.
Feedback gain [0,0.95], low-pass tone in the feedback path, dry/wet linear crossfade
[0,1]. Input stop preserves decay. Bypass emits unity dry only, feeds zero new input
to delay, and lets internal feedback decay; unbypass can expose a remaining tail.
Reset clears that tail immediately. BPM [30,300], note durations converted to
seconds; out-of-capacity behavior remains a joint read-head/tempo decision and
must not silently alter a requested rhythm. Tempo changes provisionally use the
same moving-head policy.
Feedback stability and stereo/tempo details are later integration tasks, not claims
established by this one-sample gate.

## Acceptance each lane must supply

Use unworklet offline rendering and existing test helpers after checking their
behavior. Provide independent formulas/reference oracles, endpoint and modulation
cases, sample-rate/capacity boundaries, reset tests, and exact input/settings.
No expected waveform may be copied from the implementation as its correctness
oracle. Counterexamples must fail. Human hearing can remain pending independently
of code/numerical work; artifacts stay candidates. Envelope/LFO/filter/oscillator/
voice/read-head work can proceed in parallel only after this entry contract review.
