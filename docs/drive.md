# Drive, fixed waveshapers, and reduction

Status: **CANDIDATE**. This implements catalog §7's fixed curves and a separate
intentional reduction effect. It is not an approved sound or a claim of matching
another product. Import `drive` and `reduction` from `@denaudio/den/drive`.

## Contract

Both are mono `defineSubgraph` modules, instantiated with an immutable config
containing the enclosing processor's `sampleRate` in [8000, 192000] Hz. Call each
instance exactly once per audio sample. Their state is fixed, independently named,
and handled by unworklet 0.4.1's existing snapshot mechanism. No parameter,
snapshot, routing, loader, or test framework is introduced.

`drive` config additionally requires `curve: 'hard' | 'soft' | 'asymmetric' |
'fold'`. `quality: 'direct' | 'adaa'` defaults to `'adaa'`. `dcBlockHz` defaults to
0 (off); its finite range is [0, 200] Hz. Invalid config throws at construction.

`tick(input, gain, mix, reset)` takes three f32 nodes and a bool reset. Input is
clamped to [-8,8], gain is a **linear multiplier** in [0,32], and mix is [0,1].
There is no automatic loudness compensation. NaNs become 0; infinities saturate
to the appropriate bound. These policies also apply to the dry path. Nonzero wet
gain is not a promise that output loudness matches the input.

Reset clears histories **before processing the current sample**. Construction
also starts with zero histories. In ADAA mode, the first interval is therefore
from zero to the current driven input. Quality and curve are construction choices,
not runtime switching controls; same-schema snapshot continuation is tested.
Changing quality, curve, or DC configuration and migrating a snapshot is not
supported by this module's contract. The host must construct a fresh graph and
choose its own audible transition if changing those choices.

All audio-rate gain changes are interpreted as changes in the driven signal
`x[n] = gain[n] * input[n]`; ADAA integrates between consecutive driven values.
There is no hidden gain smoothing. Arbitrary fast modulation can still generate
sidebands/aliasing. Mix is audio-rate and immediate.

## Transfer curves and their antiderivatives

The driven input is bounded to [-256,256]. Let `S(x)` be the clipped cubic:

- For |x| <= 1: `S(x) = 1.5*x - 0.5*x^3`
- Outside: `S(x) = sign(x)`

Its continuous first antiderivative, with F(0)=0, is `0.75*x^2 - 0.125*x^4`
inside [-1,1], and `|x| - 0.375` outside.

- `hard`: clamp(x,-1,1); primitive `x^2/2` inside and `|x|-1/2` outside.
- `soft`: S(x); unity positive endpoint, small-signal slope 1.5.
- `asymmetric`: S(x) for x >= 0, and S(2*x)/2 for x < 0. Its primitive is F(x)
  on the positive side and F(2*x)/4 on the negative side. Output range [-0.5,1].
  This curve can create DC from a zero-mean input; the optional blocker is useful.
- `fold`: triangular folding with period 4 and values 0,1,0,-1,0 at inputs
  0,1,2,3,4. Let t=(x+1) modulo 4 in [0,4). Output is `1-|t-2|`; its continuous,
  periodic primitive is `t^2/2-t+1/2` for t <= 2 and `3*t-t^2/2-7/2` otherwise.

Direct quality samples these curves without AA. ADAA computes
`(F(x[n])-F(x[n-1]))/(x[n]-x[n-1])` using f64 arithmetic. For a difference <=1e-5,
it uses the curve at the interval midpoint, protecting even the unselected
division because unworklet selects evaluate both branches. The maximum slope
of these curves is 1.5, so the midpoint replacement error is bounded by
`1.5*|difference|/4 <= 3.75e-6`, including a knot crossing. Smooth cubic interiors
have a second-order error. This is a difference criterion, not an exclusion of
quiet audio. Histories use exact power-of-two scaling to retain recoverable f32
subnormals through unworklet's <1e-30 state-write flush.

### AA and dry-path tradeoff

First-order ADAA is appropriate here because these are **fixed memoryless curves**
with continuous analytic primitives. It is not a generic wrapper around arbitrary
nonlinear/stateful circuits, oversampling, or a guarantee of bandlimited output.
No claim is made about an inner oversampled state/sample-rate API.

For a linear portion, ADAA is a two-sample average: half-sample group delay and
gain `cos(pi*f/sampleRate)` below Nyquist, with a zero at Nyquist. Its dry path is
the same two-sample average, preventing a dry/wet mismatch in the linear region.
It is **not transparent bypass** at mix=0. Direct quality has an undelayed dry path.
There is no integer lookahead or block buffering. Nonlinear high-frequency
behavior is not equivalent to a constant fractional delay; heavy folding can
lose substantial fundamental energy. The tests record both absolute folded
energy and fundamental amplitude, without loudness normalization hiding this.

### Optional DC blocker

The wet path only uses `y[n]=w[n]-w[n-1]+p*y[n-1]`, where
`p=exp(-2*pi*dcBlockHz/sampleRate)`. Zero disables its state and processing.
This adds phase shift and a slightly above-unity high-frequency gain; it is not
an alias-removal filter. Mix=0 stays on the mode's dry path. Reset clears both
blocker histories. Step decay, actual digital corner response, and snapshot
continuation are tested. Sudden resets/mix changes are not click-free promises.

## Intentional bit/sample reduction

`reduction.tick(input, bits, holdSamples, mix, reset)` clamps input to [-1,1]. Bits
are floored in [2,24], and holdSamples are floored in [1,4096]. NaN defaults are
input=0, bits=24, holdSamples=1, mix=0; infinities saturate. These are fixed-size
state controls, not allocations.

With L=2^(bits-1), quantization is nearest signed PCM with exactly 2^bits levels:
`clamp(floor(x*L+0.5),-L,L-1)/L`. Ties round toward positive infinity; the maximum
is 1-1/L, the minimum is -1, and silence is exact zero. The positive/negative
endpoint asymmetry is intentional and documented rather than a gain bug.

Capture happens on the first sample, reset sample, or when the current hold ends.
Bits and period changes take effect **at the next capture**, not mid-hold. A
period of N emits that captured value for exactly N samples. The dry path has
no delay and mix changes immediately. There is no antialias filter: quantization
and sample holding intentionally add distortion and aliasing. It is unsuitable
for transparent sample-rate conversion. Same-schema snapshots retain both held
audio and remaining count.

## Evidence and limits

`tests/drive.spec.ts` covers 44.1/48/96 kHz with independent scalar curves and
segmented Simpson quadrature (not copied primitives), both sides of curve knots,
near-equal input, extreme drive, signed quantizer levels, hold timing/control
changes, impulses, reset boundaries, independent instances, tiny state, graph
NaN/infinity controls without output scrubbing, and exact snapshot continuation.
It also checks cubic THD/IMD coefficients, optional DC step/corner response, and
the mode's dry-path phase/gain behavior. A bypass counterexample fails the oracle.

Alias fixtures are 8192-frame coherent sines at bins 997 and 1709, amplitude 3,
after a full warmup period. Projection removes DC and only harmonics below
Nyquist. Across the four curves the observed first-order ADAA reduction in
remaining folded RMS is **7.96–9.47 dB** relative to direct quality, exceeding
the unchanged >=6 dB test requirement. Rates use the same normalized frequencies;
these are specific synthetic fixtures, not universal audible-quality guarantees.
At bin 1709, heavy folding's fundamental falls from approximately 0.5015 to 0.0939
while folded RMS falls from 0.5535 to 0.1889. Choose direct quality when that
intentional aggressive high-frequency behavior is wanted; compare candidates.

`tests/drive-packed.test.mjs` installs a tarball into a locked isolated consumer,
checks public `/drive` declarations, renders all curves/qualities and reduction,
applies independent numerical checks, and records source/audio/package hashes.
All generated audio and manifests remain **CANDIDATE**, requiring separate human
approval. The lane has no local browser/realtime performance proof.

Bounded user-editable piecewise-linear curves are now a separate
[curve-shaper candidate](curve-shaper.md). Remaining work: higher-order ADAA, verified
oversampling wrappers, configurable multistage coloration engines, performance
and listening comparison. Composing several current instances is possible but
does not establish an oversampling or multistage-quality guarantee.

Method reference: Werner & Azelborn, [Antialiasing Piecewise Polynomial
Waveshapers, DAFx 2023](https://www.dafx.de/paper-archive/2023/DAFx23_paper_61.pdf).
This implementation derives the four simple primitives above and validates them
independently; no reference implementation or vendor audio was copied.

The separate [fixed oversampled drive](oversampled-drive.md) candidate now covers
a bounded 2×/4× memoryless composition. Its filtered dry path, FIR precursors,
32-sample bulk delay and high-treble loss are explicit; this does not add general
arbitrary-graph oversampling or higher-order ADAA to this module.
