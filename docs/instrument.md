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
  policy. Mono uses one voice; poly defaults to 16. Engine capacity is currently
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
The complete default 16-voice graph compiles. A 32-voice probe produced a
11,614,744-byte process function, exceeding WebAssembly's 7,654,321-byte function
limit. The engine rejects >16 at construction instead of failing during loading;
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
  snapshots restore parameters/shared LFO but do not revive held voices. Inactive
  histories are cleared on the first rendered sample. Follow the existing
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

Shared export integration remains separate. Proposed subpaths:
`./instrument` → `dist/instrument.js` / `dist/instrument.d.ts` and optional
`./instrument-example` → its matching files. The tests currently import installed
packed files by path; they do not claim these public subpaths already exist. No
package, lockfile, shared consumer, contracts, UI or deployment settings change
is included here.
