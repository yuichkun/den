# Candidate source and resonator catalogue

These modules extend the catalogue's FM/PM, additive, unison and tuned/modal resonator groups. They use unworklet 0.4.1 and the existing oscillator and delay-readhead. Existing instrument, voice policy, envelopes and initial presets are unchanged. Compose their outputs with the existing envelope/filter/voice instead of introducing another engine framework.

All new audio is **CANDIDATE**, not a listening-approved golden. These modules are not a commercial-instrument equivalence claim. Sample, granular, spectral/FFT, arbitrary operator routing, automatic anti-aliasing and stochastic exciters are outside this slice.

## Shared contract

Import sources from `@denaudio/den/source` and resonators from `@denaudio/den/resonator`. Construct with `instantiate(module, config, {name})` inside processor declarations. Call each instance's `tick` exactly once per sample. `sampleRate` is an immutable finite number in [8000,192000], and must match the enclosing renderer. Offline evidence covers 44100, 48000 and 96000 Hz. Use separate named instances for separate voices/channels.

All runtime controls and excitation must be finite f32 values. NaN/Infinity are outside the contract, not a musical mute/reset signal; upstream scrubbing is not validation or a quality guarantee. Out-of-range finite controls clamp as described below. Construction rejects invalid/nonfinite configuration and capacities. Core f32 precision and scalar-state flushing below 1e-30 still apply; no subnormal oscillator-frequency accumulation guarantee is made. No runtime allocation, arbitrary JavaScript callback, unbounded loop, asset load, smoothing or voice allocation is added. All loop counts are fixed at graph construction.

The existing unworklet snapshot mechanism owns state. Same configuration/schema snapshots resume phases, feedback, modes and delay history exactly in the tested renderer. Reset is a sample-level boolean, not an edge detector. A caller wanting one reset should supply one true sample. Rate or structural configuration changes require a new graph; no cross-rate/cross-schema migration guarantee is made.

## Phase modulation

`phaseModulation({sampleRate}).tick({carrierHz, modulatorHz, depthRadians, feedbackRadians, reset})` returns mono f32.

- Carrier/modulator frequencies clamp to [0,.45 sampleRate] Hz. Zero Hz holds phase.
- Depth clamps to [-8π,8π] **radians**. Feedback clamps to [-π,π] radians.
- At sample n, output is `sin(2π p[n] + depth[n] sin(2π m[n]) + feedback[n] y[n-1])`. The modulator and previous output are f32; accumulated phase and sine polynomial arithmetic use f64.
- Output precedes phase advance by each current frequency/sampleRate. A frequency change preserves phase. Reset sets both phases and the previous carrier output to zero before this output. Held reset emits zero every sample. Initial phase and feedback are zero; no random seed or random phase is used.
- Feedback is explicitly the final carrier output from the preceding sample, not current-sample algebraic feedback and not the modulator.

## Frequency modulation

`frequencyModulation({sampleRate}).tick({carrierHz, modulatorHz, deviationHz, feedbackHz, reset})` returns mono f32.

- Base and modulator Hz clamp to [0,.45 sampleRate]. Deviation and feedback clamp to ±.45 sampleRate **Hz**.
- Emit `sin(2π p[n])`, then advance the carrier by `clamp(baseHz + deviationHz sin(2π m[n]) + feedbackHz y[n-1], 0, .45 sampleRate)/sampleRate`.
- This is positive-frequency linear FM with clipped negative instantaneous frequency, not through-zero FM. It is distinct from PM radians, including at changing depth and frequency.
- Initialization, zero-frequency hold, reset and one-sample feedback source match PM. Held reset emits zero. There are two oscillator phases and one previous-output slot per PM/FM instance.

Neither PM nor FM is bandlimited. Their legal frequency clamps do **not** constrain sidebands to Nyquist. Strong phase modulation, clipped FM, reset and feedback can alias. The fixture explicitly measures a folded PM sideband above 0.4 amplitude with legal carrier/modulator controls; this is evidence of the limitation, not an anti-alias test pass. Feedback can produce sensitive/chaotic waveform divergence while output remains in [-1,1].

## Additive partial bank

`additiveSource({sampleRate, partials:[{ratio,gain}, ...]}).tick(frequencyHz, reset)` returns mono f32.

- 1–32 immutable sine partials. Ratio is finite in (0,128], signed gain in [-16,16]. Each reuses the existing sine oscillator.
- Base frequency clamps [0,.45 sampleRate]. Requested partial frequency is base×ratio. A partial above .45 sampleRate is muted rather than accumulated at the clamp frequency. Its oscillator still advances at the existing oscillator's clamped frequency while muted, so re-entry does not restart phase.
- All output weights are divided by the construction-time sum of absolute gains. All-zero gains produce silence. The denominator does not change when partials mute. Thus the output magnitude is at most one, without a limiter.
- All phases initially zero; reset aligns all partial phases to zero, held reset emits zero. Each partial owns independent f64 phase and has fixed per-sample cost, even when muted or weighted zero.
- Crossing a partial mute boundary is abrupt and unsmoothed. Dynamic modulation/reset can generate extra bandwidth; this is not a blanket anti-alias claim.

## Unison stereo bank

`unisonSource({sampleRate, waveform:'sine'|'saw', voices:[{detuneCents,pan}, ...]}).tick(frequencyHz, reset)` returns `{left,right}`.

- 1–8 immutable oscillator voices. Detune cents is finite [-1200,1200], pan [-1,1]. Each voice reuses the existing sine or polynomial-BLEP saw oscillator.
- Base frequency clamps [0,.45 sampleRate], then each voice multiplies by `2^(cents/1200)` and clamps again to .45 sampleRate. At high base frequencies, positive detuned voices can coincide at that ceiling; tests explicitly cover this.
- For N voices, left weight is `(1-pan)/(2N)`, right weight `(1+pan)/(2N)`. This is **linear amplitude pan**, not equal-power pan. The channel sum L+R equals the average of the mono voices; an arithmetic mono fold-down `(L+R)/2` is half that average. Centered one-voice output is half amplitude per channel. Each channel remains bounded by one.
- All phases initially zero and align on reset, with no random dispersion. Sine held reset emits zero; saw held reset emits the existing oscillator's phase-zero value (zero for positive frequency; -1 at exactly zero frequency). Frequency changes preserve phase.
- A saw's existing BLEP does not imply arbitrary audio-rate modulation, feedback or resets are alias-free. No new quality mode is advertised.

## Modal resonator

`modalResonator({sampleRate, modes:[{frequencyHz,decaySeconds,gain}, ...]}).tick(input, reset)` returns mono f32.

- 1–16 immutable modes. Mode Hz in [20,.45 sampleRate], amplitude T60 in [.005,30] seconds, gain in [-16,16]. Excitation clamps to [-1,1].
- A mode has complex poles `r exp(±jω)`, where `r=exp(-ln(1000)/(T60 sampleRate))`, `ω=2π Hz/sampleRate`. Recurrence is `y[n]=sin(ω)x[n]+2r cos(ω)y[n-1]-r²y[n-2]`.
- Unit impulse response is `r^n sin(ω(n+1))`. It starts on the current sample; T60 is the pole envelope decay, not a guaranteed peak ratio between arbitrary sampled extrema. The magnitude-response peak can differ from pole angle slightly.
- Signed mode gains divide by their absolute sum. All-zero gains return silence. This bounds the **unit-impulse** response by one, not sustained resonant output. Sustained excitation can exceed unity by large amounts. With bounded input, a conservative weighted bound is the largest `1/(1-r)`. Long decay requires substantial downstream headroom/gain control; no limiter is included.
- Reset clears both histories per mode before current excitation; held reset emits only the zero-history `sin(ω)×input` contribution each sample. Initial histories are zero. Two fixed f64 slots per mode store histories scaled by 2^128 to preserve legitimate tiny f32 tails through the upstream scalar-state flush; external units remain unchanged.
- The modes form a fixed linear resonator bank after an explicitly clipped excitation stage, not a nonlinear physical string/plate model. Excitation waveform, envelope, velocity mapping and musical mode choices belong to the composition.

## Tuned comb

`tunedComb({sampleRate,minFrequencyHz}).tick({input,frequencyHz,feedback,damping,reset})` returns mono f32.

- Minimum frequency is finite [20,.45 sampleRate]. Fixed buffer capacity is `ceil(sampleRate/minFrequencyHz)+2` f32 samples plus cursor/validity and damping state. Tick frequency clamps [minFrequencyHz,.45 sampleRate]. Delay is 1/frequencyHz seconds through the existing moving, linear-interpolated delay reader. Actual minimum delay exceeds two samples at the maximum frequency, and is always at least one sample.
- Excitation is passed linearly, without a clipper. Supply finite input bounded by a known magnitude B with adequate f32 headroom. Feedback clamps [-.999,.999]. Damping clamps [0,1] and is the one-pole memory coefficient: `filtered=(1-damping)tap+damping*previousFiltered`. Zero bypasses damping; one freezes the filter history (zero when just initialized/reset).
- Read the delayed tap, update damping, then write `(1-|feedback|)×input+feedback×filtered` into the line. Normalization is applied to excitation before storage. Return the raw delayed tap, with no instantaneous dry path. For fixed feedback this equals output-normalizing the conventional feedback comb, but changing feedback never rescales stored history. Reset invalidates history and zeroes damping **before** current excitation is written; held reset returns zero.
- Input bounded by B, convex damping/interpolation and `|feedback|≤.999` give the ideal-arithmetic induction `|write|≤(1-|g|)×B+|g|×B=B`, including arbitrary finite feedback/frequency/damping changes. Reset/empty history is zero, so history, filter and output remain within B in ideal arithmetic. Unit-input tests use a 0.001 floating-point headroom allowance (scaled with B) and an independent normalized-history oracle and a retained executable counterexample for the rejected output-normalization topology; this is a normalized feedback network, not a brickwall limiter. Parameter edits still change the sound and can click.
- Integer-delay undamped positive feedback has repeats every delay samples; negative feedback reverses alternate repeats. Fractional interpolation and damping change pitch and decay, so `frequencyHz` is the delay tuning control rather than a pitch-perfect physical-string guarantee. Moving delay produces Doppler behavior. Abrupt parameter changes/reset need caller-managed transitions if clicks are unwanted.

## Verification and evidence

`tests/source.spec.ts` independently checks Math.sin recurrence, Bessel sidebands, intentional folded alias, 32-partial peaks, detune ceilings, stereo normalization, reset, held reset and snapshots. `tests/resonator.spec.ts` checks analytical impulse/pole/T60 behavior, maximum 16-mode sustained excitation/headroom, tiny tails, signed comb repeats, damping freeze, moving-delay/feedback changes, fixed capacities and snapshots. Every in-contract render requires zero upstream scrubbed samples.

`tests/source-packed.test.mjs` installs a fresh packed package using an exact consumer lock, checks public declarations/imports, renders all families at three rates, compares analytical references, verifies snapshot continuation, and records package/source/audio hashes and fixed-graph driver diagnostics. Evidence is local offline/Node driver evidence only, not browser/hardware real-time acceptance. The integration owner must still run exact-head CI and independent review. Candidate WAVs remain unapproved.
