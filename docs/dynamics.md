# Dynamics and envelope follower candidate

Status: **CANDIDATE**. Implements the single-band detector/gain-law part of
[catalog sections 5 and 9](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3).
It is not a lookahead/true-peak limiter, multiband processor, or an assertion of
listening approval. The original voice feedback concerned earlier candidates,
not these algorithms or generated clips. Independent final review and aggregate integration verification remain
separate gates.

## Composition and boundaries

Public candidate subpath: `@denaudio/den/dynamics`, added with integration-owner
approval. The packed fixture requires this export and records its tested import. No new routing, parameter, snapshot, asset or runtime API is
introduced. Use the existing unworklet `instantiate` and stable unique names.

- `envelopeFollower`: reusable mono peak or RMS detector. Configuration is
  `{ sampleRate, mode: 'peak' | 'rms' }`; `tick(input, controls)` returns a
  nonnegative f32 amplitude. Controls are `attack`, `release`, `reset`.
- `compressorGainDb(levelDb, controls)` and `expanderGainDb(levelDb, controls)`:
  stateless downward gain laws, returning dB gain in `[-rangeDb, 0]`.
- `dynamics`: stereo feedforward composition. Configuration adds
  `operation: 'compressor' | 'expander' | 'gate' | 'duck'` and optional fixed
  `hysteresisDb` (default 3 dB, allowed 0–24 dB).
- Call `tick(left, right, sidechainLeft, sidechainRight, controls)` exactly once
  per sample. Results are `left`, `right`, `envelope`, linear `gain` and `gainDb`.
  Pass the program L/R again as sidechain L/R for internal detection. Mono callers
  duplicate their input explicitly. An external key never becomes audible audio.
- Controls use existing f32 Nodes. `reset` is a boolean Node. Construction rate
  must be an integer in 8000–192000 Hz and must match the processor's compile rate.
  Mode and operation are construction-time choices, not dynamic CPU bypasses.

No makeup gain, automatic normalization, mix, bypass, sidechain filter, hold,
lookahead, feedback topology, channel adaptation or latency compensation is
hidden in this composition. The program path has zero sample delay. Finite
program audio is not clipped at full scale, and gain never exceeds unity.

## Detector and gain ballistics

For a peak detector, the target is `abs(input)`. RMS uses `input²` as its target,
smooths **power**, then returns the square root. RMS is an exponentially weighted
power measurement, not a rectangular finite window or a true-peak estimate.

For either target, choose attack when target exceeds prior state and release
otherwise. With positive time `t`, the one-pole coefficient is
`c = 1 - exp(-1 / max(1, t * sampleRate))`; update by `(1-c)*previous + c*target`.
Times are seconds, clamped to 0–30. Positive sub-sample times use one sample as
the time constant. Exactly zero is instantaneous. A constant rising peak step
reaches `1-exp(-1)` after one time constant; an RMS power step reaches its square
root at that time. These meanings differ from a 10–90% timing convention.

In `dynamics`, `detectorAttack`/`detectorRelease` control the above measurement.
`attack`/`release` separately smooth the requested positive attenuation in dB:

- Compressor/duck: attack increases attenuation; release returns toward unity.
- Expander/gate: attack opens the gain; release increases attenuation.

Time edits take effect on the current sample without clearing history. There is
no implicit gain smoothing in the two standalone gain-law functions. Using zero
times or editing range/threshold abruptly can create discontinuities. Gain
smoothing prevents a hard keyed jump when its times are nonzero, but this is not
a perceptual guarantee against pumping, clicks or modulation artifacts.

## Static laws and stereo behavior

`DynamicsGainControls` contains:

| Control | Unit and range | Nonfinite fallback |
| --- | --- | --- |
| thresholdDb | dBFS, -120…24 | 0 |
| ratio | 1…100 | 1 |
| kneeDb | full width, 0…48 dB | 0 |
| rangeDb | maximum attenuation, 0…120 dB | 120 |

For compressor input level `x` and threshold `T`, the hard-knee output level is
`x` below threshold, and `T + (x-T)/ratio` above it. Within a positive knee width
`W`, the gain is `(1/ratio-1)*(x-T+W/2)²/(2W)`. The outer pieces meet with
continuous value and first derivative.

For downward expansion, the output slope below threshold is `ratio`, and the
slope above threshold is 1. Within the knee, gain is
`-(ratio-1)*(x-T-W/2)²/(2W)`. The attenuation of both laws is capped by `rangeDb`.
Ratio 1 or range 0 gives unity. Gain-law level inputs are bounded to -900…900 dB,
with -900 dB substituted for nonfinite values. This is a defined numerical
boundary, not a limiter ceiling.

Gate/duck use a hysteretic comparator. The key becomes active at or above
threshold; it stays active until its measured level reaches or drops below
`threshold-hysteresisDb`. Gate requests zero attenuation when active and
`rangeDb` otherwise; duck does the reverse. Ratio and knee are ignored by these
two operations. There is no separate hold timer. At nonzero levels the meter
uses unworklet 0.4.1's approximate logarithm, so its threshold transition has
small numerical uncertainty, approximately 0.0001 dB within tested ranges.

Both operations use the same detector linkage: maximum absolute L/R **before**
power/peak ballistics. This deliberately preserves a unilateral transient; it
is not a summed or mean-power stereo RMS measurement. Both program channels
receive precisely the same gain. Opposite polarity keys cannot cancel one
another. Sidechain filtering can be composed outside this module.

## Reset, finite inputs and state

Reset clears detector and attenuation histories and clears the gate/duck active
flag **before consuming the current sample**. Current input can immediately
reopen the key. The attenuation history starts at zero (unity); a cold/reset gate
with a silent key therefore closes according to release, not instantly unless
release is zero. A reset can change gain abruptly and is not bypass.

Every nonfinite audio or sidechain sample (NaN/±Infinity) is explicitly replaced
by zero. All finite f32 magnitudes, including values above full scale and
subnormals, remain valid. Nonfinite time controls use zero; finite out-of-range
controls clamp. Tests require `scrubbedSamples == 0`, so upstream output scrubbing
is not accepted as evidence of finite processing.

The detector's two fixed f64 slots are a scaled history and an exponent scratch
slot. The full composition has seven fixed scalar slots, no buffers and no
runtime allocation. unworklet 0.4.1 flushes scalar stores smaller than `1e-30`;
RMS power would otherwise lose recoverable audio below roughly `1e-15`. Histories
are therefore stored with the exact power-of-two scale `2**256`. Squared minimum
f32 input remains representable above that flush boundary even with a 30-second
attack; maximum scaled f32 power stays below `2**512`. Any eventual flushed tail
is already too small to return as f32 audio. Scale/unscale is exact in binary64.

Coefficient evaluation uses a degree-13 polynomial for `1-exp(-x)` on `(0,1]`,
with remainder at most `1/14!`. This avoids cancellation and long-time stalling
from `1-f32(exp(-x))`. History uses a convex weighted sum to preserve a tiny
instantaneous target after a large prior level. dB-to-linear gain uses the pinned
unworklet exp approximation; measured gain error is covered by independent tests.
The -600 dB meter floor affects only the gain-law level, not the returned envelope
or the program audio. Supported thresholds are at least -120 dB.

Same-schema, same-rate snapshots preserve detector, attenuation and hysteresis
continuation. Cross-mode/rate/schema migration is not promised. There is no
serialized preset format in this module.

## Verification and remaining gates

`tests/dynamics.spec.ts` independently checks analytical peak/RMS responses,
step/burst/reset and a-rate time edits, hard/soft knee transfer curves, ratio-one
and range limits, stereo swapping/tracking, external keys, hysteresis, snapshot
continuation, malformed controls, full finite f32 range, subnormals, large→tiny
transitions and finite diagnostics. All three routine rates (44100/48000/96000)
are covered; RMS steady sine energy and very slow tiny attacks are checked too.
State count and a <64 KiB compiled-artifact guard bound construction growth.

`tests/dynamics-packed.test.mjs` packs the actual package, installs a fresh
locked consumer, type-checks declarations strictly, and renders all four modes
at those three rates against independently computed detector and input/output
transfer formulas. It writes 12 stereo WAV candidates and a hash manifest under
`artifacts/dynamics/<trial>/`; repeated runs keep earlier trials rather than
overwriting timing outliers. Generated audio is never an approved golden. Snapshot
continuation, stereo ratios and zero scrub diagnostics are mandatory assertions.

The packed fixture also records 2048 warmed 128-frame Node-driver wall-clock
measurements per operation, artifact bytes and fixed memory size at 48 kHz.
These are local diagnostics, exclude I/O copies and browser scheduling, and are
**not** an AudioWorklet deadline gate. Worst observations are retained.

Not yet established by this lane: browser rendering or controls, hardware-output
continuity, cross-browser deadline behavior, listening judgement of pumping,
transients, release, low-frequency distortion or stereo image, and aggregate public API
integration. This candidate adds no
true-peak, multiband or overall sound-quality claim. Full repository verification,
independent final review and exact-head CI belong to integration before merge.

## Initial local verification record

Node 24.19.0 with locked unworklet 0.4.1: clean `npm ci --offline`, strict
`npm run check`, and all 45 focused tests passed using Vitest's supported threads
pool. The isolated packed consumer also passed all 12 renders. Its worst observed
audio/reference residual was 1.280e-6, gain residual 9.538e-6 dB and envelope
residual 2.979e-8, with zero scrubbed samples. This does not claim the full
repository aggregate suite ran in this lane; integration owns that check.

The initial local Node diagnostic measured 8,683–12,335-byte WASM and a fixed
65,536-byte memory for the packed consumer (including its audio and parameter
ports). Median 128-frame process time was approximately 35–57 microseconds. One
expander wall-clock observation exceeded the nominal 2.667 ms quantum budget
(maximum 3.250 ms); other operations in that trial had zero such observations.
This is retained evidence under a shared host, not a pass/fail deadline verdict
or a reason to infer a DSP defect without isolating scheduling effects.
