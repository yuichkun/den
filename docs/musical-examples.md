# Musical chains and original materials

Status: **CANDIDATE**. Four small, editable unworklet compositions address original
catalog groups 12 (concrete chains/blends) and 13 (sounds/configurations/materials).
Their A/B variants form a separate future listening group. None inherits the
initial five settings' listening feedback, golden status, or runtime clearance.
No original instrument or delay setting is changed.

## Public use and native controls

Import the four processors, their plain parameter maps and host-side asset
builders from `@denaudio/den/musical-examples`. `src/musical-materials.ts` is an
implementation detail; no private `dist` import is needed. These are ordinary
`defineProcessor` declarations, native a-rate AudioParams, one native `load`
message per resident and existing same-schema state. There is no preset format,
parameter registry, MIDI/voice allocator, loader, routing or second runtime.

All processors emit stereo `main`. `shapedEcho` accepts mono audio input `main`.
The other three have native gate controls. A host can drive those AudioParams
from buttons, an existing keyboard/MIDI mapping or automation; this example does
not implement or claim that host input layer. Gates are high at values >=.5.
Supply finite controls inside the declared bounds. Native parameter descriptors
are not a sanitizer for arbitrary offline arrays, NaN or infinities.

Use the existing unworklet host API to create/connect/resume at **48 kHz** for
browser use. This lane's evidence is offline at 44.1/48/96 kHz; it does not establish
browser execution of these exact graphs, scheduling capacity, output-device
playback or hardware latency. Existing Vite worklets remain 48-kHz-specific.

### Preloading and cleanup

`glassDyad` needs the complete `makeGlassDyadTable()` result: 384 mono f32 samples
comprising three consecutive 128-sample cycles, without duplicate endpoints.
`grainCloud` needs `makeGrainCloudSample()`: 4096 mono f32 frames at a declared
source rate of 48 kHz. Generate these arrays on the host, send one native
`load` message with `{ data }`, and keep gates down until the host has established
the message's delivery boundary. The examples do not add an acknowledgement or
loader. The deterministic offline fixtures deliver at quantum 0 and start gates
at sample 128 or later. Live hosts must establish their own boundary rather than
assuming that elapsed wall time proves delivery.

Loading copies into the resident during native message dispatch; it is bounded,
not a callback-free/zero-cost promise. Both inputs have capacity-16 message rings.
Missing/unloaded assets are silent. The wavetable also stays silent if fewer than
all 384 required frames are loaded. Replacing a table restarts both table phases
but does not retrigger their existing amplitude envelopes. Grain replacement
invalidates current grains; while gate stays high, new grains resume only on
later scheduled onsets, not an implicit sample-player restart. Neither replacement
crossfades. Keep gates down/reset for changes that must be inaudible.

An empty `load` logically unloads the resident; it does not securely erase buffer
bytes or old snapshots. Host disposal/disconnection uses existing unworklet APIs,
not a den-specific cleanup method. Tests establish source completion/reset/unload
silence, not browser-node destruction. Stop gates/input and leave time for the
stated tails before disconnecting, or use reset for an immediate discontinuous mute.

## A. Glass Dyad

`glassDyad`, `glassDyadParameters`, `glassDyadBrightParameters`,
`glassDyadConstruction`, `makeGlassDyadTable`.

Two independently gated, independently tuned resident-wavetable voices share one
small table. Each uses the existing linear ADSR: 12-ms attack, 200-ms decay to
.65 sustain, 280-ms release. A fresh gate edge resets that voice's oscillator;
frequency edits preserve phase. Linear stereo weights are .75/.25 for voice A
and .25/.75 for B; this is not equal-power panning. Shared frame morph is linear.

- A: 220/330 Hz, morph frame .25, final gain .2.
- B: same notes/envelope/gain, initial morph 1.75 for a richer second/third harmonic.
- Bounds: each frequency 55–1200 Hz; frame 0–2; final gain 0–.3.
- Asset: frame weights `[.8]`, `[.6,.2]`, `[.4,.25,.15]` at harmonics 1–3.
  The fixed absolute weight sum .8 bounds every table frame and interpolated read.
  With both envelopes <=1 and per-channel pan weights summing to one, the ideal
  per-channel output is <=.8 × gain, or .16 at the candidate gain. No limiter or
  peak normalization is involved. Arbitrary replacement PCM invalidates this bound.
- No block/lookahead delay. Sine phase-zero and the attack make the initial sample
  zero; that is waveform/envelope behavior, not claimed hardware latency.
- Gate-off reaches exact source silence within 280 ms (nearest f32-seconds frame
  count). There is no extra FX tail. Reset consumes a held gate, so it stays
  silent after reset release until a new gate edge.
- Fixed resources: two oscillators/envelopes, one 1536-byte PCM buffer and a
  24,576-byte ingress payload arena, plus native state/metadata/I/O.

The synthetic frames have only three specified low harmonics, but interpolation,
fast morph/frequency edits, reset and replacement are not guaranteed alias-free.
There are no automatic mipmaps or general bandlimiting.

## B. FM Modal Hit

`fmModalHit`, `fmModalHitParameters`, `fmModalHitBellParameters`, `fmModalHitModes`.

A fixed A3/220-Hz FM body is linearly blended with an impulse-excited modal bank.
Gate rise latches strength, resets both FM phases, restarts the amplitude envelope,
and clears the old modal history before injecting one strength-scaled impulse.
This is intentional hard retrigger, not additive overlapping resonances. It keeps
the modal contribution inside the independently proved unit-impulse bound.

The FM amplitude has 1-ms attack, 180-ms decay to zero and 40-ms gate-off release.
Its instantaneous deviation follows that envelope; modulation feedback is zero.
Modes are 220 Hz/T60 .42 s/gain 1, 351 Hz/.24 s/.6 and 563 Hz/.15 s/.35, normalized
by the fixed sum of absolute mode gains. The modal pitches do not move when the
FM ratio/deviation changes.

- A: strength .8, modulator/carrier ratio 1.5, deviation 100 Hz, modal blend .35,
  final gain .22. B: ratio 2.75, deviation 170 Hz, modal blend .7.
- Bounds: strength 0–1, ratio .5–4, deviation 0–180 Hz, modal blend 0–1, gain 0–.3.
- Strength is latched per hit, while ratio/deviation/blend/gain are live controls.
- The FM sine and normalized reset-per-hit modal impulse each stay within the
  latched strength (small floating-point tolerance); their convex blend does too.
  Candidate output bound is .8 × .22=.176. This reasoning does not apply to
  arbitrary sustained modal excitation; this example injects a single impulse.
- Modal response begins on the strike sample. No block/lookahead buffer is added.
- Gate-off releases FM but does not truncate the modal tail. The slowest pole
  envelope reaches -60 dB at .42 s after the last strike, and below -120 dB at
  .84 s. Sampled peaks need not occur exactly there. This is an asymptotic tail,
  not exact silence. Reset mutes immediately, consumes held gate and requires a
  fresh edge to strike again. Hard repeated strikes may click.
- Fixed resources: one two-operator FM source, one envelope and three modal modes.

FM is positive-frequency/clamped FM, not through-zero FM or bandlimited FM. The
candidate deviation stays below the carrier; more general modulation still has
sidebands and no blanket alias-free guarantee.

## C. Grain Cloud

`grainCloud`, `grainCloudParameters`, `grainCloudReverseParameters`,
`grainCloudConstruction`, `makeGrainCloudSample`.

Two fixed grain slots read an original periodic tone cluster. The 4096-frame
asset uses integer cycle counts 19/31/47 with weights .32/.17/.08, multiplied by
`.55−.45*cos(2πn/4096)`. It is analytic material, not sampled or downloaded audio.
The file's fixed formula and full PCM hashes are recorded in the evidence.

- A: position 512, jitter 240 source frames, speed 1, duration 90 ms, density 16 Hz,
  gain .28. B: position 2800, speed −.75, duration 120 ms, density 12 Hz.
- Bounds: position/jitter 0–4095 source frames, speed −2–2, duration 20–150 ms,
  density 0–20 Hz, final gain 0–.4.
- Source metadata is always 48 kHz. Readers apply the source/host rate ratio at
  44.1/48/96 kHz. Speed changes pitch and traversal; this is not time-stretching.
- Park–Miller seed 1741, two triangular-windowed grains, looped resident reads.
  Position/jitter/rate/duration latch at grain onset. A full pool drops onsets.
  A/B nominal density×duration=1.44, leaving room under two simultaneous grains;
  arbitrary declared-bound combinations can saturate the pool and drop events.
- Table bound .57, windows<=1, sum divided by the two-slot capacity: ideal source
  <=.57 and candidate final output <=.1596. This fixed divisor is explicit DSP,
  not loudness normalization. Replacement PCM needs its own bound.
- Gate rise starts an endpoint-zero grain, so the first sample is zero. There is
  no block latency. Grain attacks are part of each triangular window.
- Gate-off starts no further grains; exact silence follows within the largest
  duration already latched, at most 150 ms. Reset clears grains and reseeds RNG.
  Unlike Glass/Hit, a gate held high starts again on reset release. Empty unload
  stays silent even under held gate.
- Fixed resources: two grains, one 16,384-byte resident PCM buffer and a 262,144-byte
  ingress payload arena, plus native state/metadata/I/O. Maximum 32-grain capacity
  is deliberately not used and receives no deadline clearance from this example.

## D. Shaped Echo

`shapedEcho`, `shapedEchoParameters`, `shapedEchoDarkParameters`.

Finite mono input with magnitude<=1 passes through the existing soft first-order
ADAA drive, a Q=.5 TPT low-pass and the existing stereo ping-pong delay. The left
delay input receives the filtered signal, the right receives half of it, making
successive cross-feedback echoes exchange emphasis. A final explicit gain follows
both output channels. The supplied input is a .4-bound, enveloped 220/660-Hz phrase.

- A: drive 2.4, cutoff 1800 Hz, time 125 ms, feedback .25, wet blend .3, gain .2.
  B: drive 4.5, cutoff 650 Hz, time 187.5 ms, wet blend .45; feedback/gain unchanged.
- Bounds: drive 0–8, cutoff 100–4000 Hz, time 40–250 ms, feedback 0–.4, mix 0–.6,
  gain 0–.25. Delay capacity is fixed250 ms per channel.
- ADAA averages the nonlinear curve along adjacent driven samples. In its linear
  regime that has a half-sample effective phase delay and high-frequency rolloff.
  The module's own dry branch uses the same adjacent-sample alignment, although
  this composition selects fully wet drive. This is not an integer half-sample
  delay buffer or a constant broadband latency claim for a nonlinear signal.
- The filter adds frequency-dependent phase/group delay. Echo dry/wet is an
  intentional mixture of current filtered signal and delayed history; there is
  no external parallel-path latency compensation. Delay timing is f32 seconds
  and fractional linear interpolation. Time edits have moving-head/Doppler
  behavior and can click. No pitch-preserving crossfade is claimed.
- With fixed cutoff, the independent direct-form filter/echo oracle checks the
  complete composition. Tests edit drive mid-phrase. The oracle intentionally
  does not pretend that a static direct-form recurrence proves fast moving-TPT
  coefficient equivalence. Wider modulation needs the module's own evidence and
  renewed composition headroom checks.
- The chosen .5 peak guard means >6.02 dB measured headroom for fixtures; it is not
  a universal safety theorem for arbitrary controls/history. No limiter or hidden
  normalization is inserted. Reports include output measurements and explicitly
  inferred pre-final-gain peak, not a fabricated raw measurement.
- At candidate feedback .25, each repeat's envelope falls by about 12.04 dB. Ten
  repeats are below −120 dB relative to the first: 1.25/1.875 seconds at A/B times,
  plus the source/filter tail. Feedback .4 and 250-ms times have longer decay.
  Filter/feedback tails are asymptotic. Held reset mutes and clears history;
  releasing it passes any currently present input through the cold chain.
- Fixed resources: one ADAA source-history pair, one SVF, two 250-ms f32 delay
  buffers (`2*(ceil(rate*.25)+2)*4` bytes) and native scalar state.

## Reproducible numerical and listening evidence

Run `npm ci`, `npm run check`, and the focused
`npm exec -- vitest run tests/musical-examples.spec.ts --maxWorkers=1`.
`node --test tests/musical-examples-packed.test.mjs` packs the real package,
installs it in an isolated locked consumer and type-checks only the public entry.
It renders 24 A/B cases across 44.1/48/96 kHz and writes a fresh timestamped
`artifacts/musical-examples/` directory. Existing evidence is never overwritten.

Each source/settings/tarball/lock/asset/expanded-parameter/input/PCM/WAV hash is
recorded. Every WAV is unnormalized stereo 32f with the stated gain, and every
render is repeated for bit-identical PCM. A variants at all three rates must
continue bit-exactly after same-schema snapshot restoration, without reloading
resident PCM and with the remaining host parameter timeline reapplied. Reset,
held reset, fresh restart, missing/short/unloaded resident and source completion
have separate regressions. Persistent DSP state does not save pending host
automation or create a portable/cross-rate preset.

Independent oracles use periodic linear interpolation plus piecewise closed-form
envelopes, Math.sin FM and analytic modal impulse sums, BigInt seeded grain
scheduling, and piecewise Simpson quadrature followed by a static bilinear filter
and an unbounded echo timeline. Independent expectations are not recorded audio.
Deliberately wrong audio, clipping and nonfinite output must fail the same guards.
Every render requires zero scrubbed/nonfinite/clipped samples and peak<.5, useful
nonzero output, and a final 100-ms tail peak<5e-6. Source finite-tail cases also
require exact silence. Instantiation/WASM sizes are diagnostics, not loaded
browser deadline measurements. No golden is generated or approved by these tests.

For later grouped listening, use the eight 48-kHz WAVs in order Glass A/B, Hit A/B,
Grain A/B, Echo A/B at a comfortable user-controlled playback level. Compare morph
clarity/stereo balance, struck body versus bell ring, forward versus reverse grain
motion, and bright versus dark echo articulation. Evaluate clicks and subjective
quality separately from numerical correctness. Any sound-affecting edit requires
new hashed audio. Human approval, if given later, must identify those exact hashes;
it is not inferred from module acceptance or feedback on the original sounds.

### Authored fixture measurements

The initial three-rate packed run measured these maxima across each A/B pair:

| Example | Maximum output peak | Minimum measured headroom | Maximum independent sample error |
| --- | ---: | ---: | ---: |
| Glass Dyad | .150429115 | 16.45 dB | 1.50e-8 |
| FM Modal Hit | .155718207 | 16.15 dB | 2.24e-8 |
| Grain Cloud | .064521916 | 23.81 dB | 1.87e-9 |
| Shaped Echo | .183290541 | 14.74 dB | 1.50e-8 |

All had zero nonfinite, clipped or scrubbed samples. Glass/grain final tails were
exactly zero. The largest final 100-ms tail peak was 6.59e-8 for modal hit and
2.22e-8 for echo. Paired variation must additionally have a difference-signal RMS
above 10% of A's RMS; unequal hashes alone are insufficient to call a variation
meaningful. This is a numerical distinction, not a subjective-quality score.

At 48 kHz, instantiated native memory was 64/64/320/128 KiB respectively; WASM
sizes were 23,272/48,172/8,904/34,874 bytes. These are fixed-graph allocation
observations only. They neither measure native message-copy cost nor establish
loaded worklet callback deadlines. Consult the exact-commit manifest/results when
reproducing, rather than promoting these summary numbers to a wider guarantee.
