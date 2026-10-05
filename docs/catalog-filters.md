# Catalog filters: clean responses, EQ, formants and crossover

These are additive CANDIDATE modules. The initial `filter`, instrument, sound
settings and Delay FX are unchanged. No framework, dependency upgrade, dynamics
processing, automatic normalization or approved golden is added.

## Public entries and contract

All modules are unworklet `defineSubgraph` declarations. Instantiate with immutable
`sampleRate`, use `Node<f32>` signals/controls and `Node<bool>` reset, and call each
instance exactly once per sample. Each instance owns independent fixed histories.
Construction accepts finite rates 8000–192000 Hz; numeric fixtures exercise
44100/48000/96000 Hz. Browser worklet compilation remains 48000 Hz only.

- `@denaudio/den/state-variable-filter`: `stateVariableFilter({sampleRate})`.
  `tick(input, cutoffHz, q, reset)` returns simultaneous `lowpass`, `bandpass`,
  `highpass`, `notch`, `allpass`. Cutoff clamps to [20,min(20000,.45*sampleRate)] Hz,
  Q to [.5,10]. Bandpass is normalized to unity at its center; low/high resonance
  can exceed unity. This is a linear trapezoidal SVF, not a nonlinear ladder or
  character model. It uses one two-integrator history for all five responses.
- `@denaudio/den/biquad-eq`: `biquadEq({sampleRate,mode})`, with construction mode
  `peaking`, `lowShelf` or `highShelf`. `tick(input,cutoffHz,q,gainDb,reset)` uses
  the same cutoff/Q limits and gain [-24,24] dB. Shelves have fixed monotonic
  slope S=1; their Q argument is intentionally unused. The peaking filter's gain
  is the gain at center; shelf gain at center is half the requested dB, with full
  shelf gain at DC or Nyquist. No hidden makeup gain is used.
- `@denaudio/den/formant-bank`: `formantBank({sampleRate,bands})`, with 1–8 fixed
  `{frequencyHz,q,gain}` bands. Construction validates frequency within the cutoff
  range, Q [.5,10], finite gain [-1,1]. `tick(input,frequencyRatio,resonanceScale,reset)`
  applies linear frequency/Q factors, each clamped to [.25,4], then each filter's
  final cutoff/Q bounds. Parallel unity-peak bandpasses are summed with their
  specified gains. There is no normalization, vowel-recognition claim, speech
  synthesizer, or implicit voice. Negative gain is an explicit phase inversion.
- `@denaudio/den/crossover`: `crossover({sampleRate})`.
  `tick(input,cutoffHz,reset)` returns `{low,high}` from fourth-order
  Linkwitz–Riley branches: two cascaded second-order Butterworth responses each.
  A shared first-stage SVF supplies LP/HP, followed by separate LP/HP stages.
  At fixed cutoff, both outputs are -6.0206 dB at crossover and their positive-
  polarity sum has unity magnitude. The sum is an allpass: it is not zero phase,
  original PCM, a linear-phase FIR, or latency compensation.

Inputs and controls must be finite. These blocks do not clamp or sanitize audio,
apply bypass, or guarantee arbitrary modulation is stable. The tests cover
specified per-sample sweeps; fixed-parameter transfer-function guarantees must
not be transferred to arbitrary coefficient jumps. Host callers choose their
musical control trajectories and explicit dry/wet/bypass path. Reset clears
history before the current input, so it may produce a waveform discontinuity.
There is no click-free-reset claim. When input stops, IIR tails decay normally.

## Numeric and state choices

Internal audio histories are f64. unworklet 0.4.1 flushes scalar state writes with
magnitude below 1e-30, so these new modules store audio histories scaled by exact
`2**128` and divide by the same power on read. This preserves subnormal f32 signal
history without extra scale rounding. The scaled full finite f32 range remains
well within f64. Bounded nonzero coefficient scratch values are overwritten
before every use. No audio intermediate is cached merely to shorten a graph.
The initial filter's existing state/schema is not changed or migrated.

The half-angle tangent uses the existing reviewed bounded polynomial formulation.
EQ amplitude uses a degree-16 exponential polynomial on the explicitly bounded
±24 dB domain. Both SVF and EQ use a TPT two-integrator realization; EQ mixes its band/low
responses to match the RBJ static formulas. Peaking uses damping 1/(Q*A),
low shelf scales the tuning by 1/sqrt(A), and high shelf by sqrt(A), where
A=10^(gainDb/40). Independent impulse oracles use trigonometric RBJ coefficients
and direct form I. Snapshots use the existing same-processor/schema/rate contract.

## Verification and provenance

`tests/catalog-filters.spec.ts` has 49 cases covering:

- all five SVF response impulses, Q/cutoff endpoints and comparison with the
  unchanged initial low-pass at three rates (absolute sample error <2e-6)
- three EQ modes across gain/cutoff endpoints; unity at 0 dB, center/shelf gains;
  independent impulse error <1e-5
- LR4 cascade references, half-amplitude/in-phase split at crossover, sampled
  frequency magnitude-flat sum, and an explicit rejection of identity-PCM claims
- independent weighted formant-band sums and center shifts
- reset, uninterrupted same-schema snapshot continuation, lower clamps,
  controlled per-sample modulation, finite output and zero scrubbed samples
- tiny/subnormal histories at 1e-35 and 1e-39, measured against independent
  references after scaling for inspection
- invalid construction rate/band count/frequency/Q/gain rejection
- adversarial 10/100/1000 Hz cutoff sweeps at Q=10 and +24 dB across all three
  EQ modes/rates; zero scrubs and a fixed conservative peak ceiling reject
  runaway state without implying a universal headroom limit

The isolated packed consumer exercises all four public subpaths, strict NodeNext
checking, actual five-output worklet construction, three-rate offline impulse
renders, repeated PCM identity and independent references. Its per-run artifacts
link source/package/lock hashes, complete controls, source impulse, rates, raw
planar f32/WAV, fixed ±1 static waveforms, measured peaks/errors and build/WASM
hashes. The browser stage checks real 48 kHz processing, reset and native snapshot
restoration; it must pass on hosted exact-head CI before integration. Local
browser availability failures remain failed/unverified stages, never a pass.
No generated impulse WAV is human-approved musical audio or a golden baseline.

## Formula sources and boundaries

The multimode SVF follows the linear trapezoidal circuit solution described in
[Andrew Simper's SVF note](https://www.cytomic.com/files/dsp/SvfLinearTrapOptimised2.pdf).
Cytomic's [technical-paper page](https://cytomic.com/technical-papers/) states its
shared algorithmic knowledge is public domain. EQ response formulas are checked
against the [W3C/RBJ Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/).
This is an original implementation from mathematical formulas, not bundled
third-party source. The crossover is the explicit cascade construction above;
formants are an explicit parallel bank, not a borrowed commercial preset.

Nonlinear character filters, comb resonators, dynamic multiband processing and
vowel presets are separate catalog work. No universal real-time capacity,
all-device stability, transparent changing-cutoff reconstruction, or human
listening approval is established by these tests.

## Rejected implementation retained in history

The rejected `tests/fixtures/eq-before-tpt.ts` (from the first local catalog
commit `4235a0a`) retains the time-varying transposed direct-form II EQ.
Independent review found peaking-state amplification to peak 23939.65 at
44.1 kHz with a normalized 0.1 sine, Q=10, +24 dB and 100 Hz logarithmic cutoff
modulation; 1 kHz modulation overflowed/scrubbed. Static impulse agreement did
not detect this. That realization is rejected and preserved as a non-shipping counterexample
fixture. A regression confirms it scrubs under the same input that the TPT
replacement handles with zero scrubs. The reproductions are now mandatory regressions;
no threshold was raised to accept the rejected behavior. This correction changes
only the unmerged new catalog EQ, not the existing initial candidate's DSP.
