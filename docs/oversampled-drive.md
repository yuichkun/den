# Bounded oversampled memoryless drive

Status: **CANDIDATE**.

This is a fixed 2x/4x polyphase interpolation, memoryless waveshaper, and filtered
phase-zero decimation composition. It is not a generic wrapper around arbitrary
or stateful graphs, and does not create a second processing runtime.

## Public entry

`@denaudio/den/oversampled-drive` exports `oversampledDrive`,
`OversampledDriveConfig`, and `OVERSAMPLED_DRIVE_LATENCY_SAMPLES = 32`.

Config: host `sampleRate` finite in [8000,192000] Hz; immutable `factor: 2 | 4`;
fixed `curve: 'hard' | 'soft' | 'asymmetric' | 'fold'`. Existing drive modules are
not invoked at an unsupported inner sample rate. The curve is a pure arithmetic
memoryless function evaluated at the explicit high-rate phases.

`tick(input, gain, mix, reset)` once per host sample. Input intentionally clamps
to [-8,8], linear gain to [0,32], mix to [0,1]. NaN becomes zero and infinities
saturate. Dry uses the same sanitized input. Gain multiplies the base-rate input
before interpolation. There is no hidden control smoothing or loudness matching.
Mix is applied after decimation. Factor and curve cannot switch at runtime.
Aliasing already present in the host input, or created by the host-rate gain
multiplication, is not reversed by this interpolation stage.

## Filter and phase contract

For L=factor, each lowpass is N=32*L+1 taps, symmetric around D=16*L, using cutoff
fc=0.45/L cycles per high-rate sample:

h0[k] = sinc(2*fc*(k-D)) * 2*fc * Blackman(k),
Blackman(k) = 0.42 - 0.5*cos(2*pi*k/(N-1)) + 0.08*cos(4*pi*k/(N-1)).

Both endpoints are exactly zero; h=h0/sum(h0). Interpolation uses zero stuffing
followed by L*h, evaluated as fixed polyphase sums. At high-rate index L*n+r,
up[n,r] = L * sum_j h[r+L*j] * driven[n-j]. The memoryless curve is evaluated at
each upsampled value. A second h filters the shaped stream, then phase-zero
samples at high-rate L*n are retained. There is no unfiltered decimation.

The linear cascade's group delay is 2*D/L = 32 host samples for both factors.
This is bulk delay, not a requirement for silence before sample 32: the causal
response has precursors and a 65-tap support spanning 64 sample intervals.
Its dry counterpart is g[j] = L*(h convolved with h)[L*j], j=0..64. This is the
exact same linear interpolation/decimation response: identical delay and
rolloff, not merely a pure delay approximating the nonlinear path's phase.
Mix zero therefore remains filtered and delayed; it is not transparent bypass.
No sample-accurate constant group delay is claimed for arbitrary nonlinear
signals, as opposed to the surrounding linear filtering.

## State and bounds

Native fixed rings retain 33 driven base samples, 65 dry base samples, and N
shaped high-rate samples, plus cursors and valid counts. Reset invalidates old
history before consuming the current host sample; no stale samples may return.
Held reset repeatedly applies this rule. Same-schema native snapshots preserve
all histories and phase. State scaling retains recoverable f32 subnormals.

Finite FIR coefficient L1 bounds cover interpolation overshoot and dry output.
The curve limits every shaped high-rate value to [-1,1] (asymmetric [-0.5,1]);
therefore the wet output is bounded by sum(abs(h)). Transient overshoot above
unity is permitted and documented, never hidden with a final output clip.
There is no optional DC blocker or automatic limiter.

## Verification coverage

- Independent literal zero stuffing and time-domain convolution, including phase
  zero versus a deliberately wrong decimation-phase counterexample
- Symmetry, impulse support/peak, constant gain, linear dry/wet null, near-Nyquist
  attenuation and measured anti-imaging/stopband response
- Fixed synthetic folded-alias metrics and fundamental gain for direct versus
  2x/4x; no universal bandlimit or monotonic audible-quality promise
- 44.1/48/96 kHz, gain/mix changes, reset before current sample, held reset,
  independent instances, same-schema continuation, tiny and non-finite controls
- Maximum-factor graph/compile/WASM/memory/cost diagnostic and isolated packed
  public declarations, actual rendering, hashes, and native parameter edits

Any generated audio is **CANDIDATE**. Offline evidence does not establish browser
quantum deadlines, maximum simultaneous instance count, or listening approval.

The independent integration owner approved this bounded entry before DSP.
Existing `/drive` and `/curve-shaper` source and semantics remain untouched.

## Filter bandwidth and residuals

The design's individual filter magnitude is approximately 0 dB through
0.35*hostRate, -0.34 dB at 0.4*hostRate, -6.02 dB at 0.45*hostRate, -28.37 dB at
host Nyquist, and -79 dB at 0.55*hostRate. The band between 0.35 and 0.55*hostRate
is a transition, not a flat audio passband. This deliberately sacrifices high
treble near host Nyquist to attenuate images and decimation aliases.

The base-rate linear response must be computed from g, not assumed to be exactly
one filter's squared magnitude: finite residual image terms survive the
interpolation/decimation cascade. In particular the mirrored transition term
matters at host Nyquist. The per-phase interpolator's constant-input gain ripple
is about 1.7e-6 before shaping. Finite filters and a finite internal sample rate
leave residual aliases. Increasing factor alone does not make arbitrary driven
waveforms bandlimited, restore existing aliases, or guarantee better perception.

For the specified kernels, sum(abs(h)) is about 1.853 at 2x and 1.847 at 4x.
The matched dry kernel has L1 norm about 1.879, so an arbitrary bounded dry input
can reach a conservative 15.04 transient bound. This is a stability bound, not
a recommended signal level. Wet output may also exceed unity because of the
post-shaper FIR. No final clip masks those filter transients.

## Measured candidate evidence

The 11 focused tests render actual native WASM at 44.1,48,96 kHz. All fixed
curves and both factors match an independent literal zero-insertion/high-rate
convolution reference at f32 precision for the tested input, gain, mix and reset
sequences. That oracle does not use the implementation's polyphase indices or
precomputed dry kernel. A deliberately wrong decimation phase differs enough to
fail the same oracle. Linear dry/wet null, symmetric impulse peak at 32, nonzero
precursors, exact finite tail drain, resets, same-schema continuation, independent
silent instances, invalid controls and recoverable tiny impulses are checked.

A 1001-point frequency sweep of the independently generated individual FIR
finds maximum passband magnitude error below 0.000167 through 0.35*hostRate, and
stopband attenuation at least 75.27 dB from 0.55*hostRate to the internal Nyquist.
This is the stated guardband, not a promise of that rejection immediately above
host Nyquist. The native convolution-oracle checks also bind the implementation
to this filter design.

Alias fixtures use 8192-frame coherent sines at bins 997 and 1709, amplitude 3,
after a complete period of warmup. Projection removes DC and harmonics below
host Nyquist; the residual is measured without loudness normalization. Across
all four curves at the three rates, folded RMS falls 13.75–27.78 dB at 2x and
29.98–48.63 dB at 4x versus direct shaping. The requirements remain 6 dB and 10 dB
respectively. Fundamental amplitudes are recorded separately, and are preserved
to about 5e-5 absolute amplitude in these specific fixtures. Different inputs,
gain modulation, and frequencies can produce different outcomes.

`tests/oversampled-drive-packed.test.mjs` installs the actual tarball into a locked
isolated consumer. Strict public declarations, native a-rate gain/mix writes,
all 24 factor/curve/rate combinations, independent convolution, exact native
snapshot continuation, tail drain and source/package/audio hashes are required.
Whole offline-renderer output must exactly equal the manually driven native WASM
instance, rather than a recreated JavaScript processor.

The public maximum-factor candidate has at most about 0.44 MB of serialized
graph, 52,391 bytes of WASM, and fixed 65,536-byte WASM memory per instance in the
fixture. Timings are recorded separately from correctness: local process medians
are below one millisecond in these runs, but cold quanta have exceeded 19 ms.
The cold cost alone rules out claiming a verified browser deadline. These are
single-instance local Node diagnostics with host jitter and no input/output copy
or browser scheduling cost. No real-time capacity, browser worklet, device,
true-peak, or listening approval is implied.

Use the normal native construction API, for example
`instantiate(oversampledDrive, {sampleRate, factor:4, curve:'soft'}, {name:'drive'})`,
then call `tick(input, gain, mix, reset)` inside the enclosing `forSample`.
The 32-sample bulk-delay constant is useful when designing a chain, but the full
matched dry response remains necessary for this module's own linear null.
