# Pulse, triangle and deterministic noise candidates

`@denaudio/den/virtual-analog` exports `virtualAnalogSource`, `seededNoise` and
their config/control types. These additions do not change existing sine/saw,
instrument, unison, presets or sound candidates.

## Pulse and triangle

`virtualAnalogSource({sampleRate,waveform,phaseCycles?})` fixes waveform to
`'pulse'` or `'triangle'`. Sample rate must be finite 8000..192000 Hz;
initial/reset phase is in [0,1), default0. `tick({frequencyHz,duty,reset})`
returns one float32 sample. Frequency clamps to [0,.45 × sampleRate], with
NaN→0 and infinities saturated. Zero Hz holds phase. Duty clamps to [0,1],
NaN→.5; triangle ignores duty.

Pulse is +1 during phase<duty and −1 otherwise. Two-sample-support quadratic
polynomial BLEP residuals smooth its positive and negative steps. Pulse mean is
2×duty−1: non-50% pulse intentionally contains DC. Duty0 is exactly −1 and duty1
exactly +1, including reset and zero frequency. No DC blocker is hidden inside.

Triangle starts at −1 at phase0, rises linearly to +1 at phase.5, then falls.
Cubic polynomial BLAMP residuals correct slope jumps +8 and −8 cycles⁻¹. It is
direct phase evaluation, not a leaky-integrated pulse, so no integration drift or
settling tail is added. At positive step d, its phase-zero output is −1+4d/3.
At zero Hz it emits the raw triangle, including −1 at phase0.

Both constructions equal convolution of their periodic raw waveform with a
unit-area triangular kernel of half-width one output sample at constant frequency
and duty. The corresponding static harmonic transfer is sinc²(k×frequency/rate),
where sinc(x)=sin(πx)/(πx). Tests verify this independently using piecewise exact
Gaussian quadrature and Fourier coefficients, including above-Nyquist harmonics
folding into the sampled spectrum. This is finite polynomial alias reduction,
not ideal bandlimiting. Residual aliases and high-frequency attenuation remain.
The two-sample span denotes the correction support, not a two-sample output delay.

Reset is level-sensitive: emit configured phase and then advance on every true
sample. At default phase, ordinary pulse is0 when the two edge corrections do
not overlap; near duty endpoints overlap changes that value. A held reset repeats
phase, while output can still change with frequency/duty. Zero-frequency correction
is disabled with a safe denominator in every eagerly evaluated branch. Abrupt
PWM, frequency jumps and resets do not receive a crossing-time correction or
oversampling guarantee and can alias/click. PWM is not subsample-sync support.

Phase uses exact power-of-two-scaled f64 native state, avoiding the native scalar
flush below 1e-30. The smallest positive f32 frequency accumulates from zero;
ordinary f64 addition resolution still applies at a nonzero phase. No minimum-Hz
gate is introduced. At fixed valid controls pulse and triangle stay in [−1,1]
within float32 numerical tolerance. Sample-rate/config changes require a new graph.
The 2^1020 phase scale also preserves f64 `Number.MIN_VALUE` initial phase. Stored
phase is wrapped below 1 before scaling, leaving over 16× finite headroom; all
waveform and advance arithmetic happens after unscaling.

The distinction between step BLEP and slope BLAMP follows the concepts discussed
in [Esqueda, Välimäki and Bilbao, Rounding Corners with BLAMP, DAFx 2016](https://www.dafx.de/paper-archive/2016/dafxpapers/18-DAFx-16_paper_33-PN.pdf).
This implementation and its two-sample triangular-kernel coefficients were
derived independently; the paper's reported performance is not a den claim.

## Noise

`seededNoise({seed?})` uses the Park–Miller multiplier48271 and modulus2147483647.
Seed is an integer1..2147483646, default1. For each sample it computes
next=(current×48271) mod2147483647 using exact f64 integer arithmetic (product
below 2⁴⁷), stores next as i32, and returns float32(2×next/2147483647−1).
Float32 rounding can include an endpoint even though the real-valued map is open.
This deterministic generator is not cryptographic or a quality guarantee for
all statistical/audio uses; there is no pink/brown noise or noise-shaping mode.

`tick(reset)` chooses the configured seed before generating that sample whenever
reset is true. Reset therefore emits the same first sample; held reset repeats
it. Independent instances do not share state. Noise sequence is sample-indexed,
so the same seed/reset samples match at all supported host rates. Snapshot
continuation is exact for identical graph/config/rate using existing native state.

Tests at 44.1/48/96 kHz cover an independent BigInt PRNG oracle, endpoint seeds,
held reset, isolated instances, bounded finite output, mean/power diagnostics and
snapshots. Those finite-window statistics do not prove a perfectly white spectrum.
All generated audio remains CANDIDATE until separate human approval.
