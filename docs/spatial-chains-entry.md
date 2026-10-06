# Bounded hybrid space and feedforward pitched tail: proposed entry

Status: entry, source and native/public-package evidence independently reviewed
on 2026-10-06. Both entries remain CANDIDATE / NOT_CLEARED, with no human,
hardware or realtime acceptance.

## Finite catalog scope

This is one concrete mono-input/stereo-output composition for catalog groups 10
and 12, plus one explicitly feedforward pitched-tail variation. It composes the
reviewed `partitionedConvolution`, `multiTapDelay`, `algorithmicReverb` and
`windowedPitchShift` modules without modifying them. The convolution shapes three
early reflections; the parallel damped FDN supplies the late tail. The variation
pitch-shifts only a copy of the late output. Nothing from either pitch reader is
returned to the FDN or early-reflection input.

This is not regenerative feedback shimmer, a long measured-room convolution, a
physical room model, transparent pitch shifting, or completion of those broader
catalog categories. Existing frozen-tail support remains separate.

## Proposed public API

One new subpath, `@denaudio/den/spatial-chains`; no root-entry re-export:

- `hybridReverb({ sampleRate }).tick(input, controls, everyNSamples)` returns
  `{ left, right }`.
- `feedforwardPitchedReverb({ sampleRate, windowSamples? }).tick(input,
  controls, everyNSamples)` returns `{ left, right, ratioRejected }`.
- `SpatialChainConfig`: integer `sampleRate` in 8000..192000, taken from the
  enclosing `ctx.sampleRate`.
- `FeedforwardPitchedReverbConfig`: same rate plus even integer `windowSamples`
  in 32..16384, default 2048. This is the pitch delay excursion, not a grain or
  FFT-frame duration.
- `SpatialChainControls`: f32 `mix`, boolean `bypass`, boolean `reset`.
- `FeedforwardPitchedReverbControls`: the same controls plus f32 `ratio`, f32
  `pitchMix`, and boolean `retrigger`.

Call exactly once per sample in a stride-1 `forSample`, passing its native
`everyNSamples`. Construction is fixed. There is no IR ingress, runtime topology
change, alternate scheduler, preset engine or custom snapshot mechanism.

`mix` and `pitchMix` must be finite and clamp to [0,1]. `ratio` uses the reviewed
pitch reader's inclusive [.5,2] acceptance; invalid/nonfinite values retain its
last accepted ratio, or 1 on reset. A valid ratio is accepted during reset.
`ratioRejected` describes rejection of the current ratio. Both channel readers
receive identical controls and therefore have the same phase and rejection.

## Literal topology and gains

Let x be the input unless bypass or reset is true, in which case excitation is
zero. The unchanged public modules are composed as follows:

1. Convolve x with B=8, N=16, one fixed eight-tap original FIR:
   h=[.625,0,0,.25,0,0,0,-.125]. Its L1 gain is 1 and DC gain is .75.
2. Feed that convolution to `multiTapDelay` with `maxDelaySeconds=.023`,
   feedback=0, mix=1 and bypass=false. Its three fixed taps are:
   (.007 seconds, left .5, right .25),
   (.013 seconds, left .25, right -.25),
   (.023 seconds, left -.125, right .375).
   The existing normalization divisor is exactly 1; each channel's L1 sum is
   .875. Call this stereo early output E.
3. Independently feed (x,0) to `algorithmicReverb` with roomScale=1,
   decaySeconds=.6, dampingHz=min(3500,.4*sampleRate), mix=1, bypass=false.
   Call this stereo late output F. No early signal enters the FDN.
4. Plain hybrid wet output is .5*E+.5*F.
5. The pitched variation applies one reviewed moving-window reader to each F
   channel. Let that output be Q(F). Its late blend is
   T=(1-pitchMix)*F+pitchMix*Q(F), and wet=.5*E+.5*T.
6. The final output is (1-mix)*originalInput+mix*wet, with mono dry copied to
   both channels. Use f64 for the wrapper blend and convert once to f32.

The plain entry has no pitch readers or pitch allocation. The two entries may
share a private construction helper, not a new exported routing abstraction.

Supply finite normalized input [-1,1]. The FIR output fits the existing
multitap/convolution operating range and |E|<=.875*peak|input| in real arithmetic.
Start auditions around input peak .25 to leave working headroom; this is a
recommended level, not a proved output ceiling. FDN peaks can exceed unity.
There is no limiter, automatic normalization or output saturation.

The unmodified FDN keeps its fixed contractive feedback and damping. For a
finite-energy mono input from zero state its existing conservative wet L2 bound
uses 1/(1-qMax), where qMax=10^(-3*dMin/(sampleRate*.6)). Pitch is strictly outside
that loop. Convex interpolation/window weights bound each pitched sample by the
largest retained late sample, but do not imply energy preservation: a moving
reader can repeat, omit or cancel input. Do not transfer the FDN's orthogonality
claim to a hypothetical pitch-in-feedback implementation.

## Timing, phase and finite storage

Dry is immediate. There is no host latency compensation or hidden dry alignment.
The early FIR contributes exactly 8 samples of scheduling latency. It is not
linear phase, so its coloration has frequency-dependent group delay. Its impulse
support is 0..7 before that scheduling delay. Reflection tap times are fixed
f32-seconds requests through the reviewed linear readhead, not exact integer
delays: effective d=clamp(sampleRate*fround(seconds),1,.023*sampleRate).
Their fractional interpolation must be included in the numerical oracle.

The first ideal early support is at 8+floor(d7ms). The last ideal early support
after a last nonzero input at n is no later than n+8+7+ceil(d23ms), subject to
native floating-point residuals. This 7..23 ms reflection geometry does not
rescale the eight FIR samples with rate.

The FDN's four lengths are round(sampleRate*[.0297,.0371,.0411,.0437]). Its f32
seconds readhead boundary can introduce the existing tiny fractional difference.
First late arrival is near 29.7 ms, and the damping filters add frequency-dependent
loop group delay. The .6 second setting specifies loop loss, not a hard tail
cutoff or exact measured RT60. There is no finite mathematical drain for the
IIR tail. Continue processing zeros or reset it.

Pitched read ages are 1..W+1 after the FDN output. After reset/retrigger, ratio=1
gives exactly 1+W/2 samples of extra delay. Other ratios, or unity after arbitrary
modulation, have no single latency. Parallel pitched/unpitched mixing may comb or
cancel. Linear reads can alias; coherent and noncoherent pitch behavior must both
be retained as evidence. If the late input to a reader actually becomes zero,
that reader is silent from its last nonzero sample+W+2 onward; the FDN itself has
no such finite cutoff.

Storage is the sum of unchanged modules:

- Three reflection histories, each ceil(.023*sampleRate)+2 f32 values.
- Four FDN histories, each ceil(sampleRate*(d_i/sampleRate))+2 f32 values,
  including any existing floating-point ceiling guard; four damping states.
- One B8/P1 convolution: 8 f64 input, 2*16 f64 previous spectrum, 16 f64 overlap,
  2*16 f64 mixed scratch and 4*16 f64 FFT scratch values, plus native scalar state.
- Pitched entry only: two (W+3)-value f64 histories, i.e. 16*(W+3) bytes, plus
  native cursors, valid counts, phases, accepted ratios and transient wet slots.

These are construction-fixed. Actual compiled/native instance memory includes
runtime, scalar and port overhead and will be measured. No callback allocation
or buffer growth is introduced. The FDN/reflection f32 histories inherit their
existing very-small-state precision/scrub behavior; this wrapper does not promise
retention of all subnormal input magnitudes.

## Controls, reset, bypass and native restoration

Reset has highest priority: emit zero even when bypass is true, suppress the
current excitation, invalidate every module's history and reset pitch phase.
Held reset remains silent and discards every reset sample. Native convolution
hop phase is preserved. This explicit wrapper behavior is stricter than the
underlying FDN/multitap reset-accepts-current-input contract.

Bypass emits unity dry, admits no new wet excitation, and continues all internal
tail/readhead processing. It does not save CPU; removing bypass reveals the then
current tail. mix=0 still excites and advances both wet branches. pitchMix=0 still
advances the pitched entry's readers. Retrigger resets both pitch phases before
their current read, retains history and can click. No smoothing or universally
click-free automation, reset, retrigger or bypass is claimed.

Use only native same-rate, same-schema snapshots. Every inherited persistent
history/cursor/valid count, convolution scheduling state, FDN damping state and
pitch ratio/phase persists; transient scratch must be rewritten before use.
Restore requires the same configuration and coordinated input/control timeline.
The existing non-atomic core 0.4.1 AudioParam/state restore boundary remains:
render and verify saved controls before browser restoration. Native offline
quantum continuation is a separate exact test, not a claim of atomic live restore.

## Required independent evidence

Before acceptance: independent absolute-time FIR/tap/FDN/pitch references at
44.1/48/96 kHz; impulse arrivals and path signs; linear dry/wet and pitch endpoints;
simultaneous versus separate-path algebra; normalized bounded excitation and
finite zero-scrub output; every B8 reset phase; held reset and reset+bypass;
bypass admission/re-entry and uninterrupted tails; pitch rejection, retrigger and
known coloration/cancellation; same-schema noninitial quantum restoration with
poisoned transient scratch; minimum/maximum valid capacities and fixed memory.

Integration requires actual packed public imports/declarations, native three-rate
rendering and an actual small 48 kHz browser composition with independently
predicted phase/gain or sample waveforms, control edits/reset and correctly
coordinated native restore. Diagnostic costs retain cold/warm misses and do not
certify realtime behavior. Candidate audio stays CANDIDATE and hashed.

## Initial native verification

On 2026-10-06 the new source passed `npm run check` and all 20 focused cases in
`tests/spatial-chains.spec.ts`. The absolute-time reference includes f32 fraction,
multiplication, addition and storage boundaries of the inherited readheads. The
three-rate tests cover the complete chain equations, signed reflection arrivals,
every B8 reset phase, reset+bypass priority, native same-schema continuation,
and bypass re-entry after suppressed excitation with a continuing nonzero tail.
The pitched entry at pitchMix=0 is bit-identical to the plain hybrid output.

The full-composition W64/ratio2 counterexample removes independently predicted
early output and finds no intended doubled-frequency late component for a
128-sample-period input, while an original-frequency component remains. It is
retained as a pitch-quality limitation, not promoted by a waveform-oracle pass.

Native capacity/scratch probes at 8/44.1/48/96/192 kHz, including W32 and W16384,
keep memory fixed, produce finite output with zero nonfinite-output scrubs, and
match the scalar oracle within the predeclared 2e-6 absolute tolerance under
normalized square-wave excitation. Poisoning all 11 declared transient scalar
temporaries and six transient work buffers leaves subsequent audio bit-identical.
The separate public snapshot test restores serialized persistent histories;
the poisoning probe clones native memory only as a test of scratch independence.

The guarded source/type/native batch completed in 15.35 seconds, with 486,039,552
bytes maximum summed process-group RSS. This process measurement is not a
per-quantum deadline result. Actual browser worklet and exact-head aggregate CI
remain separate acceptance requirements. No human listening or hardware clearance
follows.

## Packed and independent review evidence

`tests/spatial-chains-packed.test.mjs` checks strict public declarations, both
actual public subgraphs, native a-rate mix/ratio/pitchMix and input controls at
44.1/48/96 kHz, and the W16384/192 kHz maximum. The first clean packed proof at
commit `b173a3e` had maximum absolute waveform error 2.981e-8, bit-identical suffix
PCM and final native snapshots, fixed memory and zero nonfinite-output scrubs.
Both distinct Vite WASM/worklet bundles were built; building is not browser
execution. Three hashed five-channel WAVs retain raw input and stereo outputs
as finite CANDIDATE excerpts, with no normalization or complete-tail-drain claim.

The local-only dependency reuse option is rejected in CI. It requires the exact
locked non-target resolutions, creates a private installed target from the new
tarball, preserves the donor tar/lock/installed target, and fingerprints every
non-target dependency package before and after. The first proof verified all of
those identities unchanged. CI retains the isolated fresh-install path.

The packed process batch completed in 14.61 seconds with 776,314,880 bytes maximum
summed process-group RSS. Loaded native measurements include host input/parameter/
output copies over 256 quanta per profile:

| Rate | Hybrid cold / warm max | W512 pitched cold / warm max | Quantum budget |
| --- | --- | --- | --- |
| 44.1 kHz | 3.203 / .711 ms | 3.694 / 3.723 ms | 2.902 ms |
| 48 kHz | 3.242 / .942 ms | 3.302 / 1.326 ms | 2.667 ms |
| 96 kHz | 3.398 / 1.712 ms | 5.530 / 2.402 ms | 1.333 ms |

Every measured profile missed its cold deadline; some warm maxima also missed.
The maximum pitched configuration used 458,752 native bytes and 54,056 WASM
bytes with no memory growth. These observations preserve NOT_CLEARED and do not
predict browser scheduling or hardware capacity.

An independent review imported neither the author processor nor its scalar
oracle. It compared all 182 installed package files against the actual tarball
and passed 16 native/public groups. A separate 4-by-4 complex FDN resolvent,
combined with the FIR/fractional taps, dry path and initial unity-pitch delay,
predicted both channels at four simultaneous coherent frequencies. Across both
entries and 44.1/48/96 kHz, maximum complex-transfer error was 9.664e-10 against a
predeclared 2e-6 tolerance. Independent reset/bypass/mix, ratio rejection including
NaN/infinities, native snapshot and minimum/maximum capacity probes also passed.

The independent 8 kHz headroom witness used mix=1 and input +1 for residues
0..127 of each 257-sample period, -1 for residues 128..256, then zero after sample
8191. Hybrid output reached 1.131077647; the W32 variant at ratio=1 and pitchMix=1
reached 1.088592649. These concrete unclipped peaks confirm that normalized input
can exceed unity at output. They are examples, not peak ceilings. Independent
source/native review found no implementation blocker; browser, final-head CI,
listening and realtime acceptance remain separate.
