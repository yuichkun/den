# Modulation, stereo delay and algorithmic reverb candidates

Status: **CANDIDATE**. These are composable DSP modules, not human-approved sounds,
finished room/plate emulations, or a browser real-time performance guarantee.
The catalog source is [sections 8 and 10](https://www.notion.so/3ef449b4e81d817db1acf1fff48779b3).

Public entries:

- `@denaudio/den/modulation-fx`: `flanger`, `phaser` and their config/control types
- `@denaudio/den/stereo-delay`: `pingPongDelay`, `multiTapDelay`, `StereoDelayConfig`,
  `PingPongControls`, `DelayMixControls`, `DelayTap`, `MultiTapDelayConfig`
- `@denaudio/den/reverb`: `algorithmicReverb`, `AlgorithmicReverbConfig`, `ReverbControls`

All use existing `defineSubgraph` / `instantiate` and state/snapshot mechanisms.
No loader, routing, serialization, parameter, or test framework is added.
Keep unworklet at 0.4.1. The root entry does not re-export these candidate modules.

## Shared entry contract

Instantiate during graph construction with `sampleRate: ctx.sampleRate`; rates are
integer Hz in [8000, 192000]. Call each instance's `tick` exactly once per sample.
Audio and continuous controls are `Node<'f32'>`, reset/bypass are `Node<'bool'>`.
Inputs and controls must be finite. Numerical tests use nominal audio within
[-1, 1]; extreme near-overflow f32 input is not a supported operating level.
There is no output limiter and wet/feedback paths can exceed unity.

`mix` is linear dry/wet in [0, 1], clamped at the endpoints. A zero mix continues
feeding/advancing the effect. Bypass emits unity dry, stops new input to the wet
network, and continues its existing tail. Re-enabling it reveals that continuing
tail. Bypass does not save CPU. Reset clears effective history **before** the
current input is processed. Holding reset continually clears history. Reset and
bypass together suppress new wet input; reset alone accepts the current input.

No implicit parameter smoothing or click-free bypass is claimed. Abrupt controls
can create discontinuities. The caller owns musical modulation and smoothing.
Persistent histories use the existing snapshot path; tests cover exact same-rate,
same-schema continuation. Cross-rate snapshots and changed construction schemas
are not asserted compatible. unworklet scalar writes flush values below 1e-30;
very small tails therefore differ from ideal infinite-precision equations.

## Flanger

`flanger(config).tick(left, right, controls)` is stereo-in/stereo-out and returns
`left`, `right`, `timingRejected`, `modulationClipped`.

Construction controls:

- `maxDelaySeconds`: fixed per-channel capacity, one sample through 0.02 seconds;
  default 0.02
- `stereoPhaseCycles`: finite relative right LFO phase; default 0.5

Sample controls: `delaySeconds`, `depthSeconds`, `rateHz`, `feedback`, `mix`,
`bypass`, `reset`. Base time must lie in [one sample, capacity]. Invalid time emits
dry, stops new wet input, and preserves the prior valid internal time (or minimum
time on reset), reporting `timingRejected`. Depth and rate inherit existing delay
bounds: depth [0, 0.05] seconds, rate [0, 20] Hz; the resulting moving head is clipped
to the declared short capacity and reports `modulationClipped`.
Feedback is positive, clamped to [0, 0.95].

This intentionally reuses `delayFx`, `delayReadhead` and the existing LFO. Flat
feedback and short delay create the comb response: with a static integer delay D,
wet transfer is z^-D / (1 - feedback*z^-D). At zero feedback and 50% mix, the first
notch is at sampleRate/(2D). Tests check complex frequency response, not merely a
renamed chorus preset. Wet latency is the selected delay; dry has no added delay.
Linear interpolation attenuates high frequencies and moving delay produces
Doppler pitch changes. There is no through-zero or negative-feedback mode.

## Phaser

`phaser(config).tick(input, controls)` returns one mono sample. Compose independent
instances, or use different modulation trajectories, for stereo.

- `stages`: fixed 2, 4, 6 or 8 first-order allpasses; default 4
- `frequencyHz`: common per-stage -90 degree frequency, clamped to
  [20, 0.45*sampleRate]
- `feedback`: signed previous-sample wet feedback, clamped to [-0.95, 0.95]
- `mix`, `bypass`, `reset`: shared behavior above

With a = (tan(pi*f/fs)-1)/(tan(pi*f/fs)+1), a static stage has transfer
(a + z^-1)/(1 + a*z^-1). Stages are normalized lattice sections:
y = a*x + b*s; next_s = b*x - a*s; b = sqrt(1-a*a). The scattering matrix is
orthogonal, so even changing a every sample cannot create energy in that isolated
section. The bounded sine/cosine polynomial uses f64 arithmetic, followed by f64
coefficient, signal, history and feedback staging. This does not promise absence
of modulation sidebands, perceptual artifacts, or numerical error.

Static wet magnitude is unity; dry/wet cancellation produces the phaser notches.
At 100% wet it is an allpass phase effect, not an EQ notch bank. There is direct
feedthrough, no lookahead, and exactly one sample in the explicit feedback path.
A normalized realization is deliberate: a time-varying direct-form allpass does
not inherit the same per-sample energy argument automatically.

## Ping-pong delay

`pingPongDelay(config).tick(left, right, controls)` returns stereo samples and
`timingRejected`. `maxDelaySeconds` is fixed, one sample through 8 seconds;
default 2. `timeSeconds` sets both channel delays and has the same invalid-request
policy as the flanger base time. It is a moving, linearly interpolated head;
there is no dual-head transition or internal tempo conversion.

Feedback is signed and clamped to [-0.95, 0.95]. Both channels are read before
either channel is written. The left wet output feeds the right input and vice
versa. A left-only impulse appears on the left after D samples, right after 2D,
left after 3D, with amplitudes 1, g, g². No extra sample enters this circulation.
A duplicated mono input stays symmetric. A feedback filter is not part of this
candidate; the existing `delayFx` provides filtered independent-channel repeats.

## Multitap delay

`multiTapDelay(config).tick(monoInput, controls)` returns `left`, `right`.
Construction fixes 1–8 taps and the common `maxDelaySeconds` capacity (default 2,
up to 8 seconds). Each tap has `delaySeconds`, `gainLeft`, `gainRight`. Times must
fit [one sample, capacity]; signed gains must be finite and in [-1e6, 1e6].

All gains share divisor max(1, sum(abs(left gains)), sum(abs(right gains))). This
preserves signs, each channel's relative tap levels, and stereo ratios; it reduces
absolute level when either sum exceeds unity. There is no per-tap auto gain or
energy-based normalization. The post-normalization L1 sum in either channel is
at most one, giving the mixed-tap feedback path a clear amplitude bound.

Each tap reuses one independent `delayReadhead`, read once and written once per
sample. This deliberately spends N fixed-capacity buffers instead of changing the
existing readhead's single-read contract. Feedback is the average of the two wet
channels, multiplied by signed gain [-0.95, 0.95], then added to mono input before
all tap writes. Opposite-polarity stereo taps can cancel in this feedback sum.
Dry mono input is copied to both channels. There is no runtime tap insertion,
reordering or time control; rebuild for a different rhythmic pattern.

## Small algorithmic reverb

`algorithmicReverb(config).tick(left, right, { mix, bypass, reset })` returns
stereo samples. The network has four fixed delays and a Hadamard/2 orthogonal
feedback matrix. Reference delays are 29.7, 37.1, 41.1 and 43.7 ms, scaled and
rounded to sample counts at construction.

- `roomScale`: fixed [0.5, 2], default 1
- `decaySeconds`: fixed low-frequency target RT60 [0.1, 10], default 1.5
- `dampingHz`: fixed matched-z one-pole corner [20, 0.45*sampleRate], default
  min(6000, 0.45*sampleRate)

Each delay's loop gain is 10^(-3*delaySamples/(sampleRate*decaySeconds)). The damping
pole exp(-2*pi*dampingHz/sampleRate) makes a convex one-pole lowpass, so high-band
decay is shorter than the low-frequency target. Room, decay and damping are
construction settings, **not runtime modulation controls**. Compute rate-relative
settings from `ctx.sampleRate`, including during unworklet's eager 48 kHz capture.

Input stereo is injected through two orthonormal Hadamard columns and wet stereo
uses two other orthonormal projections. Hadamard diffusion occurs at every return;
there are no extra input diffusers or hand-tuned early-reflection paths. Sparse
initial reflections and metallic modes are possible. Increasing echo density and
correct low-band decay do not establish a pleasant room/hall/plate sound.

There is no predelay or processing lookahead. The first wet arrival is approximately
29.7 ms*roomScale; dry is immediate. This is an acoustic network delay, not a host
latency-compensation value. Four buffers use the existing readhead capacity rule,
ceil(sampleRate*maxDelaySeconds)+2; floating-point ceiling can add a guard slot.
Passing their times through the existing f32 seconds API introduces at most a small
fractional-sample interpolation difference; the independent reference includes it.
This implementation is damped, not a lossless network or freeze effect.

No convolution, IR handling, FFT, shimmer, frequency shifter or preset engine is
included. There is no claim of matching a commercial reverb or a physical room.

## Verification and reproducibility

Focused suites are `tests/catalog-modulation-fx.spec.ts` and
`tests/catalog-reverb.spec.ts`, at 44.1, 48 and 96 kHz. They check independent
complex comb/allpass responses, DC/Nyquist and cutoff extremes, lattice
fast-modulation energy, signed ping-pong timing against a non-ring timeline,
normalization/polarity/steady-state tap levels, reset/bypass/mix, fresh silence,
exact same-schema continuation, stereo and mono behavior, FDN impulse/matrix
references, bounded energy, echo-density growth and band-decay fits.

The FDN 0.6 s decay fixture requires a low-band fitted RT60 between 0.45 and 0.75 s
and high-band RT60 below 65% of low-band RT60. This explicitly allows finite-window
and modal estimation differences; no test threshold is adjusted from an observed
result. A separate 43.7-second offline fixture exercises maximum 10-second decay,
sustained stereo excitation and a long tail. Every render requires finite outputs
and zero reported scrubbed samples.

`tests/catalog-modulation-packed.test.mjs` installs the actual tarball into a fresh
consumer, checks public-entry types, renders WASM at all three rates, builds a Vite
worklet bundle, and records CANDIDATE WAV files plus package/source hashes under
`artifacts/catalog-modulation`. Building a worklet bundle is not browser execution.
Exact-head CI/browser verification belongs to the integration gate. These tests do
not measure hardware audio, scheduler deadlines, maximum voice count, or universal
runtime performance. Listen to candidate material before musical approval.

## Algorithm sources

- Julius O. Smith, [delay-line interpolation](https://www.dsprelated.com/freebooks/pasp/Delay_Line_Signal_Interpolation.html)
  and [allpass sections](https://www.dsprelated.com/freebooks/filters/Allpass_Filter_Sections.html):
  background for the interpolation and static allpass transfer properties.
- Sebastian J. Schlecht and Emanuel A. P. Habets,
  [On Lossless Feedback Delay Networks](https://arxiv.org/abs/1606.07729): matrix
  losslessness background. This candidate adds fixed losses and independent tests;
  the paper is not evidence of this implementation's musical or runtime quality.

Implementation is original TypeScript composition of den/unworklet primitives;
no external DSP source code or audio assets were copied.


## Review clarifications and boundary correction

`decaySeconds` sets each FDN line's nominal loop-gain loss, not an exact measured
RT60 or a hard 10-second tail ceiling. Damping suppresses high frequencies, but
very low damping also adds loop-filter group delay and can lengthen low-band
decay. Independent review at 48 kHz, roomScale 0.5, decaySeconds 10 and damping 20 Hz
measured asymptotic stereo-energy RT60 of 14.8826 seconds (fit 5–15 seconds of a
43.69-second impulse render, zero scrubs/nonfinite values). Independent
matrix-pole analysis predicted 14.9275 seconds. This stable setting is retained
with the correct interpretation, not described as a measured 10-second maximum.

The catalog integration also corrects the shared read-head's one-sample
construction boundary. At rates such as 8001 Hz, `sampleRate*(1/sampleRate)` can
round below 1. Construction now checks the seconds value against the exact
computed reciprocal first, then floors the already-valid product at one sample.
The immediately smaller representable seconds value still rejects. Regression
coverage checks new wrappers plus old/new audio, complete state and WASM parity
for the original 44.1/48/96 kHz paths. No broader capacity rounding is introduced.
