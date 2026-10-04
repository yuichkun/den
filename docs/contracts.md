# Entry contract for parallel DSP work

Status: proposed integration contract, awaiting independent entry review. These
are the initial den-specific decisions for GEN-611 through GEN-616; only the gate
fixture is implemented. Changes to shared exports, package/lockfiles, consumer,
or these boundaries belong to the integration lane.

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
- Save after AudioParam edits have actually rendered, while controls are stable
  (#78). A suspended snapshot is not a reliable capture of pending edits in 0.4.1.
  This gate does not solve suspended preset editing or in-flight automation recall.
- Worklet compilation is sample-rate-specific. Build/load for the actual context
  rate using unworklet; do not carry compiled artifacts across rates. Numerical
  lane coverage starts at 44100, 48000, and 96000 Hz, 128-frame render quanta.
- State allocation is fixed at graph creation. No dynamic audio-thread allocation.
  Reset uses existing node/event control, clears histories/voices/phase immediately
  at its dispatched sample, and may create a discontinuity. Reset is not bypass.

## Module boundaries and initial bounds

| Lane | Graph boundary and units | Fixed policy for first integration |
| --- | --- | --- |
| Envelope (GEN-611) | Gate/retrigger → normalized unipolar level [0,1] and completion flag. Attack/decay/release seconds [0,30], sustain [0,1]. | One state per voice/use; zero time is instantaneous. Retrigger from current level; note-off releases from current level. Completion only when release reaches zero. Lane selects/documents curve law; no second envelope engine for pitch/filter. |
| LFO/modulation (GEN-614) | Rate Hz [0,20], phase cycles [0,1), reset → bipolar unit signal [-1,1]. Depth is applied at the destination in its own units. | Rate 0 holds phase. Free-running or explicit phase reset; no implicit note reset. First shape sine; further shapes need lane tests. Pitch depth semitones [-24,24], cutoff depth octaves [-8,8], delay depth seconds [0,0.05]. Clamp the composed destination to its bounds. |
| Filter (GEN-612) | Mono normalized audio → mono audio; cutoff Hz [20,min(20000,0.45×sampleRate)], resonance Q [0.5,10]. | One low-pass method selected and justified by this lane. Independent state per voice/channel. Reset clears history. No hidden gain normalization; response/peak bounds must be established before integration. |
| Voice policy (GEN-616) | Existing MIDI events → per-voice note, gate/retrigger, velocity [0,1], release completion. | Fixed 16 slots; mono uses one. Mono last-note priority, legato preserves envelopes until an explicit retrigger. Poly reuse free, then oldest releasing, then oldest active voice; deterministic slot-index tie break. Duplicate note-ons allocate separately; note-off releases oldest matching active channel/note. Velocity-zero note-on means note-off. Completion returns a voice to free; reset/all-sound-off clears all. |
| Oscillator (GEN-613) | Frequency Hz [0,0.45×sampleRate], phase reset → mono signal nominally [-1,1]. | Per-voice phase cycles [0,1); rate 0 holds. MIDI tuning A4=440 Hz, equal temperament. Lane selects one band-limited method and documents alias/level limits. Reset phase 0. No new MIDI receiver. |
| Delay read-head (GEN-615) | Mono input and delay seconds [1/sampleRate,2] → delayed mono output. Two independent instances form stereo FX. | Fixed allocation ceil(2×sampleRate)+2 samples per channel; no resizing. Linear fractional interpolation with wrapped adjacent reads. Continuous moving head (Doppler behavior), not dual-head crossfade. Clamp time after modulation; reset clears buffer and pointers. |

Methods and exported types for unfinished modules are deliberately not stubbed:
use each lane's own tested unworklet subgraph within these boundaries, then bring
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
seconds then clamped to capacity; tempo changes use the same moving-head policy.
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
