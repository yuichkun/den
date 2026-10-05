# Editable curve shaper

Status: **CANDIDATE**.

This additive catalog §7 module is a bounded piecewise-linear user curve/LUT.
It uses only unworklet 0.4.1 graph nodes and native state. No additional parameter,
asset, snapshot, routing, loader, or test system is introduced.

## Public entry

`@denaudio/den/curve-shaper` exports `curveShaper`, `CurveShaperConfig`,
`CurveShaperControls`, and `CurveShaperQuality`.

- Config: `sampleRate` finite in [8000,192000] Hz; `pointCount` integer in [2,17];
  immutable `quality: 'direct' | 'adaa'`, default `'adaa'`.
- `tick(input, controls)` is called once per sample. `input` is f32. Controls are
  `gain`, `mix`, `reset`, and `ordinates: readonly Node<'f32'>[]` with exactly
  `pointCount` entries. Ordinates may be constants, native params, or graph signals.
- Equally spaced immutable input knots cover [-1,1], including both endpoints.
  Each audio-rate ordinate is clamped to [-1,1]. NaN becomes zero; infinity
  saturates. Values outside the knot domain use the nearest endpoint ordinate.
- Input clamps to [-8,8], gain to [0,32], mix to [0,1], with NaN becoming zero.
  Gain is a linear multiplier; no automatic loudness compensation is applied.
- Direct quality evaluates linear interpolation of the current ordinates.
- ADAA averages the **current sample's curve** over the previous/current driven
  input interval by summing overlap trapezoids. It never differences primitives
  computed under different ordinate values. At almost equal inputs a midpoint
  replacement uses distance <= 1e-6/(pointCount-1). Since each segment has
  slope magnitude <= pointCount-1, the mean-versus-midpoint error is bounded by
  slope*distance/4 <= 2.5e-7, including knot crossings.
- Gain and ordinate edits are immediate. This antialiases the input interpolation
  for a fixed curve; rapid curve edits can still produce sidebands and aliasing.
  There is no smoothing, edit crossfade, arbitrary-graph oversampling, higher-order
  ADAA, or guarantee of a bandlimited output.
- Direct dry is immediate. ADAA dry is the same two-sample mean as a linear curve,
  with half-sample group delay and cosine rolloff. Mix zero is not transparent
  bypass in ADAA mode. Arbitrary asymmetric curves can generate DC; no DC blocker
  is built in.
- Reset clears input and dry histories before the current sample. The first ADAA
  interval therefore begins at zero. Same-schema native snapshots preserve those
  histories. Point-count or quality migration is not promised.
- Output is bounded by the blend of |dry|≤8 and |wet|≤1. State uses exact binary
  scaling to retain recoverable f32 subnormals through native state-write flush.

## Evidence and limits

Independent scalar interpolation and knot-segmented quadrature, 44.1/48/96 kHz,
minimum and maximum point counts, asymmetric and folded user curves, knots and
endpoint extension, finite/extreme/non-finite controls, gain/mix/ordinate editing,
reset, same-schema snapshot continuation, independent instances, tiny inputs,
linear dry alignment and measured fixed-curve folded-alias comparisons.

The packed isolated consumer must compile only public declarations, render actual
WASM, check the independent oracles and record source/package/audio hashes.
Generated audio is **CANDIDATE**, never an approved golden. Browser deadline,
listening approval, and oversampling are separate claims.

The independent integration owner approved this bounded entry before DSP
implementation. Existing `/drive`, reduction, and all other DSP remain untouched.

## Numerical implementation

Internally, t=(pointCount-1)*x makes knot locations exact integers separated by
2. Sign-changing segments use a barycentric zero-crossing anchor, with explicit
zero-valued endpoint branches and protected zero-slope division. This avoids
spurious nonzero output at symmetric zero crossings when the original x spacing
is not exactly representable in binary. Same-sign segments use ordinary linear
interpolation. Histories retain the driven x rather than a rounded LUT index.

The rejected fractional-knot/root implementation is retained only in a test
fixture. Its four-point symmetric curve creates about 5.55e-17 of spurious DC
at exact zero; the silence oracle must continue rejecting it. It is not shipped.
The corrected implementation is checked for exact silence and signed recoverable
f32 tiny inputs at every point count from 2 through 17.

## Example construction

Use three native f32 AudioParams named `negative`, `center`, and `positive`, with
initial values -1,0,1 and bounds [-1,1]. Use native `instantiate(curveShaper,
{sampleRate, pointCount:3, quality:'adaa'}, {name:'shaper'})`, then pass their
`.at(i)` values as `ordinates` inside `forSample`.
Changing the center ordinate makes the curve asymmetric; editing both endpoints
alters polarity or folds the transfer without replacing the graph. The point
count remains fixed. This is an example of graph composition, not a custom
parameter manager or curve-asset loader.

The focused suite has 17 tests. Actual native offline rendering at 44.1,48,96 kHz
passes the interpolation/quadrature, edit, reset, state, non-finite, tiny-signal,
and alignment checks above. Two fixed five-point curves, [-1,-1,0,1,1] and
[-0.5,-0.5,0,1,1], are measured with coherent 8192-frame sines at bins 997 and
1709, amplitude 3, after one full period of warmup. Projection removes DC and
only harmonics below Nyquist. The remaining folded RMS decreases by 8.64–9.47 dB
in ADAA versus direct quality, exceeding the test's fixed 6 dB requirement.
Fundamental amplitudes are recorded without loudness normalization. These are
specific fixed-curve fixtures, not guarantees for arbitrary edits or signals.

`tests/curve-shaper-packed.test.mjs` installs the actual package tarball into a
locked isolated consumer, checks public TypeScript, and renders the minimum and
maximum point counts in both modes at all three rates. Gain, mix and every
ordinate are written through native a-rate parameter blocks, including edits
inside a block. An independent scalar interpolation/segmented Simpson reference
has maximum f32 error below 6e-8 in this fixture; the fixed limit is 8e-7. Reset and
exact same-schema continuation are checked in the native offline renderer, whose
whole output must also exactly match the manually driven public WASM instance.

The maximum 17-point ADAA graph is about 0.79 MB of serialized graph and 78,938
bytes of WASM. Each test instance retains fixed 65,536-byte WASM memory. Local
128-frame process timings include cold execution and host jitter, with observed
maxima above the quantum budget in some runs. These diagnostics are not a browser
or real-time capacity approval. Host composition and simultaneous instance count
need their own measurements; a small LUT can cost substantially less than 17
points. There is no browser worklet or listening approval in this lane.

Oversampling, explicit interpolation/decimation FIRs, integer latency compensation,
and higher-order AA remain unimplemented. This candidate closes the bounded
editable-LUT part of catalog §7 only; it does not establish a new oversampling
quality for existing `/drive` or arbitrary stateful graphs.
