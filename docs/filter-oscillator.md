# Filter and oscillator numerical contract

GEN-612 and GEN-613. Implemented as unworklet 0.4.1 `defineSubgraph`
declarations, with required immutable configuration and independent named state.
Call each instance's `tick` once per sample, inside `forSample`. All signal
arguments are finite `Node<'f32'>`; reset is `Node<'bool'>`. Configuration rate
must equal the compiled/rendered rate. The numerical construction domain is
8000–192000 Hz; acceptance renders are separately 44100, 48000 and 96000 Hz.
No parameter, MIDI, routing, state codec, noise generator or loader is added.
For percussion noise, compose the existing unworklet `noiseSource` in the engine.

## Low-pass

`instantiate(filter, { sampleRate }, { name })` returns
`tick(input, cutoffHz, resonanceQ, reset) -> Node<'f32'>`.

The two-integrator trapezoidal state-variable method preserves meaningful
integrator state during coefficient edits. Cutoff clamps to
`[20, min(20000, 0.45 * sampleRate)]`; Q clamps to `[0.5, 10]`.
Reset clears both histories **before** consuming the input at that sample.
There is no smoothing, gain compensation, saturation or limiter. The caller
owns modulation depth and gain staging. Slots `band` and `low` are f64 to avoid
low-cutoff cancellation/accumulation; audio output remains f32.

Let `g=tan(pi*cutoff/rate)` and `k=1/Q`. Solving the trapezoidal integrator pair
simultaneously gives `band=(s1+g*(input-s2))/(1+g*(g+k))`,
`low=s2+g*band`, followed by `s1=2*band-s1`, `s2=2*low-s2`.
This is derived from the integrator equations in Andrew Simper's
[trapezoidal SVF analysis](https://cytomic.com/files/dsp/SvfLinearTrapOptimised2.pdf)
(2013, updated 2016). No reference source code or PDF is vendored; repository
MIT/Apache notices are preserved. Compared with direct-form coefficient edits,
the SVF retains integrator coordinates; compared with forward-Euler SVF it avoids
an explicit-step high-cutoff stability restriction.

The independent oracle is a direct-form biquad from the bilinear transform of
`H(s)=1/(s²+s/Q+1)`, not a copy of the SVF recurrence. Its magnitude is
`1/sqrt((1-u²)²+(u/Q)²)`, `u=tan(pi*f/rate)/tan(pi*cutoff/rate)`.
DC gain is one; gain at cutoff is Q. The static response peak is one for
Q <= 1/sqrt(2), otherwise `Q/sqrt(1-1/(4Q²))` (10.013 at Q=10).
Consequently a feedback multiplier of 0.95 with Q=10 is **not** a guaranteed
stable delay loop. Use Q <= 1/sqrt(2) for a nonpeaking fixed feedback tone, or
prove the complete engine's loop gain separately. Time-varying coefficients
require complete-loop testing even at low Q; the module tests are not that proof.

Numerical acceptance: absolute impulse/direct-form error <2e-6 over cutoff
20/1000/maximum and Q 0.5/1/sqrt(2)/10; steady sine response uses independent
sample expectations and gain error <0.02 at 250/1000/8000 Hz. Alternating
minimum/maximum cutoff every sample with Q edits remains finite, peak <25 for
unit 173-Hz input, and reset removes all residual output. This peak is a fixture
bound, not a universal amplitude guarantee. DC, slowest-pole decay, reset with
nonzero input, clamp equivalence, silent second instance, and exact snapshot
continuation have separate assertions.

unworklet 0.4.1 lowers transcendental functions through f32 approximations even
for f64 input. The initial tan call failed the 2e-6 reference budget. Instead,
coefficient construction evaluates degree-13 sine / degree-14 cosine Taylor
polynomials in f64 on `[0, 0.45*pi]`. The first omitted terms bound sine error by
`(0.45*pi)^15/15!` and cosine error by `(0.45*pi)^16/16!`.
No upstream code is changed and the reference tolerance remains unchanged.

## Oscillator

`instantiate(oscillator, { sampleRate, waveform: 'sine' | 'saw' }, { name })`
returns `tick(frequencyHz, reset) -> Node<'f32'>`.

One f64 `phase` slot stores cycles in `[0,1)`. Emit current phase, then advance
by clamped frequency/rate. Frequency clamps to `[0, 0.45*sampleRate]`; zero and
negative frequencies hold phase. Reset uses phase zero for that sample, then
advances normally. A continuously true reset pins the emitted phase. A4=440 Hz
is supplied by the caller; equal-tempered MIDI mapping is `440*2^((note-69)/12)`.
There is no second MIDI receiver or tuning state.

Sine uses quadrant folding and a degree-13 Taylor polynomial on
`[-pi/2,pi/2]`, whose first omitted term is <7e-10. This avoids the dependency's
sine overshoot while retaining the original sample-error budget (<2e-6) and
nominal unit amplitude. Saw uses a four-sample polynomial step correction:
convolve four unit-width boxes to obtain the cubic B-spline kernel, integrate
it, and correct both sides of the periodic discontinuity. For distance x>=0
in sample intervals, the step complement is
`C(x)=1/2-2x/3+x³/3-x⁴/8` for x<1,
`C(x)=(2-x)^4/24` for 1<=x<2, otherwise zero.
The saw is `2p-1+2*(C(p/dt)-C((1-p)/dt))`. Both corrections are added when
supports overlap near Nyquist. No mutable BLEP buffer is required.

This is an independently derived polynomial smoothing kernel, not an ideal
brick-wall bandlimit. [Finke's published PolyBLEP example](https://www.martin-finke.de/articles/audio-plugins-018-polyblep-oscillator/)
illustrates the shorter two-sample alternative and the additive tradeoff.
No code from that example is included. The two-sample candidate measured
-43.43 dBFS folded RMS at bin 37/8192 and missed the -50 dBFS bass/pad criterion.
The four-sample method is selected by the same orthogonal-projection test:

| Fundamental / rate | Folded RMS dBFS | Improvement over naive saw |
| --- | ---: | ---: |
| 37/8192 | -53.38 | 26.01 dB |
| 997/8192 | -45.37 | 31.89 dB |
| 3501/8192 | -71.41 or lower | 62.57 dB or better |

All three sample rates pass. Projection removes only below-Nyquist integer
harmonics, so the remaining RMS measures aliased energy (plus numerical/DC
error). The naive counterexample must be >=12 dB worse. Fundamental amplitude
is independently checked against `(2/pi)*sinc(pi*f/rate)^4` within 0.002.
The kernel intentionally attenuates high harmonics and high-pitch fundamental;
there is no hidden normalization. Saw output stays within [-1,1]. At zero Hz
it emits the held naive ramp value (phase zero gives -1); starting/stopping can
therefore change the corrected value even though phase is preserved.

Bass and pad can use the saw; sine supplies percussion body/pitch sweeps.
Hard reset, abrupt pitch changes and arbitrary audio-rate FM are discontinuous
and do not inherit the stationary alias bounds. They require engine envelope
and listening assessment. No hard-sync/PM anti-alias guarantee is made.

## Packaging and integration

`npm test` covers numerical tests and a packed isolated locked consumer, including
strict declaration checking and actual oscillator -> filter rendering against
analytic sine plus the independent biquad. It emits raw f32 candidate audio,
static SVG plots, alias measurements and a manifest with source commit/hashes,
package integrity, dependency lock hash, rates and all fixture settings.
Snapshot tests are same-schema/rate only. Nothing is an approved golden.
The separate existing browser gate stays at 48000 Hz.

The packed test imports `@denaudio/den/filter` and `@denaudio/den/oscillator`
through their public package subpaths. It checks strict declarations and renders
both modules together from an isolated, locked installation. No installed-file
path escape is required. These are the same shared implementations used by the
instrument and Delay FX.
