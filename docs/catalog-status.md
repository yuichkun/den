# Catalog expansion candidates

This document tracks the additive catalog beyond the initial candidate merged in
PR26/PR30. New modules are CANDIDATE. They do not inherit the initial sounds'
listening feedback, approved-golden status, or any runtime clearance.

## Included lanes

| Module group | Public entry | Verification boundary |
| --- | --- | --- |
| Multimode SVF, peaking/shelf EQ, formant bank, LR4 crossover | `/state-variable-filter`, `/biquad-eq`, `/formant-bank`, `/crossover` | Independent static/moving-coefficient, endpoint, state and public-package checks; the rejected direct-form EQ is retained as a nonshipping regression fixture |
| Peak/RMS follower, compressor/expander/gate/duck | `/dynamics` | Independent ballistics/gain-law, tiny/full-range/state/stereo and isolated three-rate package tests; timing is diagnostic rather than a browser deadline guarantee |
| Hard/soft/asymmetric/fold drive, direct/ADAA quality, reduction | `/drive` | Independent curve/quadrature/alias/phase/state and public-package tests; intentional reduction aliasing and ADAA tradeoffs are explicit |
| Flanger/phaser, ping-pong/multitap delay, small algorithmic FDN | `/modulation-fx`, `/stereo-delay`, `/reverb` | Independent impulse, modulation energy, timing, stereo, tail/decay and installed-package checks; actual 48 kHz worklet gate |
| PM/FM, fixed additive/unison banks, modal/comb resonators | `/source`, `/resonator` | Independent sideband/alias, recurrence/convolution, bounded-control, linearity/state and three-rate public-package checks; the rejected output-normalized comb transient remains an executable counterexample |
| Musical clock/sequence, MSEG, held/random modulation, fixed MIDI arp | `/modulation` | Independent rational-clock, BigInt PRNG, curve, reset/seek/state, unsigned native MIDI timestamp/order and public-package checks; external MIDI delivery is unverified |
| Resident sample, mapped multisample, bounded grains | `/sample` | Native PCM ingress, loaded-length boundaries, independent playback/grain/replacement/state oracles and maximum fixed-capacity public-package proof; loaded runtime cost is not inferred from unloaded driver profiles |
| Resident wavetable and prepared pitch bands, pulse/triangle, seeded noise | `/wavetable`, `/virtual-analog` | Independent interpolation/quadrature/Fourier/PRNG, tiny/full-range/state and three-rate packed evidence; host-prepared harmonic truncation and native band/frame morph are covered; interpolation images and fast-control aliasing remain |
| Sustain/expression policy, glide, 12-TET tuning | `/performance` | Independent native MIDI identity/ordering/pedal/controller and tuning/glide oracles; fixed four-voice/eight-identity bound, no general MPE |
| FFT/STFT identity and small fixed partitioned convolution | `/spectral`, `/convolution` | Independent DFT/WOLA/direct-FIR, arbitrary reset/snapshot and nested native scheduler proofs; public STFT N<=1024 now has persistent hop-phase proof; convolution B<=32/IR<=128 remains a feasibility boundary |
| Explicit-feedback character filter | `/character-filter` | Independent small-signal/DC/nonlinear feedback, all-state bounds, alias, tiny-state and packed evidence; not analog-circuit equivalence |
| Hilbert additive-Hz frequency shift | `/frequency-shifter` | Independent FIR/sideband/phase/state and packed checks in the documented useful band; delayed bypass and retained alias/headroom limits |
| Lookahead sample-peak limiter and compensated three-band dynamics | `/lookahead-limiter`, `/multiband-dynamics` | Independent sliding-window ceiling, latency/reset/full-range/state and complex allpass reconstruction; neither true-peak nor general real-time clearance |
| Editable piecewise-linear curves | `/curve-shaper` | 2..17 native audio-rate ordinates, independent interval quadrature, corrected tiny-knot behavior and same-schema state; higher-order AA remains separate; fixed oversampling has its own entry below |
| Fixed 2×/4× oversampled drive | `/oversampled-drive` | Independent literal zero-stuff/FIR/decimation, curve/phase/state and packed proof; matched filtered dry, 32-sample bulk delay, precursors and high-treble loss are explicit |
| Dual-head delay-time transitions | `/dual-head-delay` | Independent absolute-history crossfade/queue/timing/reset/state oracles, maximum fixed capacity and packed tests; fixed heads do not imply click-free or general pitch/time behavior |
| Bounded input pitch shift | `/windowed-pitch-shift` | Two complementary moving windows, independent coherent-frequency/alias/cancellation/latency/state oracles and packed tests; arbitrary tones may color or cancel, no general time stretch |
| Manual lower-zone expression routing | `/mpe-expression` | Native MIDI member/master bend/pressure/CC74 routing, independent identity/controller/snapshot/audio proof; no full MPE pedal/RPN/hardware claim |
| Framewise spectral gate | `/spectral-gate` | Independent dense-DFT/bin-mask/WOLA, frame-sampled controls, phase/state and public-package checks; no-hook STFT identity is byte-identical and processed tails require2N drain |
| Prepared-spectrum convolution | `/prepared-convolution` | Certified unchanged host packet, fixed B128/P64 and8192 taps, independent direct/quantized FIR, native load/reset/state and public-package proof; quantization, preload and deadline limits remain |
| Crossfaded resident loops | `/loop-crossfade` | Independent forward/reverse/fractional/overlap/replacement/state proof; effective period is L-F, no unchanged-duration or arbitrary-content seamlessness claim |
| Native bounded take recorder | `/resident-recorder` | Independent sample-by-sample append/pause/full/reset, loaded-prefix/readback, finite-range, maximum-capacity and native snapshot/public-package proof; no device capture or streaming layer |
| Controlled FDN frozen tail | `/freeze-reverb` | Independent recurrence, input suppression, bounded transition, frozen-energy drift, native history restore and public-package proof; finite-precision and runtime limits remain |
| Experimental bounded resident WSOLA | `/resident-time-stretch` | Independent exact rational active-duration/EOF, grain-local sampling/search, native state and public-package proof; severe padded-tail carrier loss, dominant-frequency deviation and CPU deadline misses prevent transparent-quality or realtime acceptance |
| Octave-periodic musical pitch quantizer | `/pitch-quantizer` | Independent exhaustive-lattice nearest/tie/Schmitt/reset/state and public-package checks, including sparse-array rejection; bounded pitch-control quantization, not audio pitch detection or event-time quantization |
| Bin-centered spectral freeze | `/spectral-freeze` | Independent dense DFT and circular-shift WOLA, every supported hop/reset/state class and public-package checks; held output is N-periodic with captured-window modulation, not transparent or phase-locked sustain |
| Four complete A/B musical examples | `/musical-examples` | Original deterministic materials, complete native controls, 24 three-rate A/B rows, repeat/state/tail/headroom and independent musical checks; new audio is CANDIDATE |

Contracts, controls and limitations are detailed in [filters](catalog-filters.md),
[dynamics](dynamics.md), [drive](drive.md), [modulation/reverb](catalog-modulation-fx.md),
[sources/resonators](sources.md), [control modulation](control-modulation.md),
[samples](sample.md), [wavetable](wavetable.md), [prepared pitch bands](wavetable-bands.md), [VA/noise](virtual-analog.md),
[performance](performance.md), [spectral framing](spectral.md), [convolution](convolution.md),
[character filter](character-filter.md), [frequency shift](frequency-shifter.md),
[limiter/multiband](lookahead-multiband.md), [editable curves](curve-shaper.md)
[fixed oversampling](oversampled-drive.md), [dual-head transitions](dual-head-delay.md),
[windowed pitch shift](windowed-pitch-shift.md), [lower-zone expression](mpe-expression.md),
[spectral gating](spectral-gate.md), [prepared convolution](prepared-convolution.md),
[crossfaded loops](loop-crossfade.md), [take recording](resident-recorder.md),
[frozen tails](freeze-reverb.md), [experimental resident WSOLA](resident-time-stretch.md),
[pitch quantization](pitch-quantizer.md), [bin-centered spectral freeze](spectral-freeze-entry.md),
and [musical examples](musical-examples.md).
All remain editable unworklet subgraphs. No parameter, MIDI, state, routing,
loader, asset or test framework is introduced. Dependencies stay at unworklet 0.4.1. The only initial-DSP source exception is
a narrowly tested one-sample read-head construction-boundary correction; existing
common-rate audio/state/WASM parity is required.

`tests/catalog-composition.test.mjs` is the additional deployment-side boundary:
it builds the actual packed drive/dynamics composition and the nine-output FX
fixture into browser worklets. Native 48 kHz render, parameter edits, snapshot
restoration, tail decay and cleanup must pass in exact-head CI. The offline
component uses an independent fixed-input algebraic gain oracle. Offline success
at 44.1/48/96 kHz is never described as browser multi-rate support.

`tests/source-control-browser.test.mjs` adds a small seven-output source graph
(PM/FM, two additive partials, one unison voice, two modal modes and a comb), plus
native clock/sequence/MSEG/sample-and-hold/random controls. Analytic RMS/DC and frequency-bin checks, noninitial seek/held/random state,
reset and same-schema restore are required at actual 48 kHz. The source history
probe freezes nonzero phases, resets to zero, then checks recovery after restore.
The maximum-capacity source graph stays a separate offline/cost fixture: its
32 partials, eight unison voices and 16 modes have exceeded the local 128-frame
quantum budget. The small browser functional gate does not certify that graph's
real-time deadline. The fixed arpeggiator has native output-ring/timestamp evidence
at three offline rates; browser-to-host/device delivery is not claimed.

`tests/materials-browser.test.mjs` requires actual 48-kHz native PCM-message
load, short replacement, unload and persistent-asset restore. The small sample
fixture ties every PCM sample to its rendered position and checks bounded grains,
N8 STFT/short-convolution DC and held reset. Its spectral browser checks are
functional: exact latency and continuation remain independently proved offline.
A one-voice performance fixture checks native note/pressure/bend/CC input,
frequency-bin retuning, sustain release, transient-note snapshot behavior and
panic. A separate small wavetable/VA graph checks asset completeness, frequency
edits, discrete pulse/triangle Fourier amplitudes and seeded-noise reset.

`tests/advanced-browser.test.mjs` adds actual 48-kHz signed-shift frequency bins,
useful-band image rejection, linked sample-ceiling edits, and independent complex
APlo×APhi reconstruction. Wet compression is checked separately from the aligned
dry output. Editable-curve tests check the linear two-tap transfer and a changed
ordinate's analytical DC value. Browser reset and parameter restoration are
functional checks; exact timing/state continuity remain independently proved
offline. The character-filter packed gate separately exercises native drive,
resonance/pole edits and noninitial history recovery in an actual browser.

The resource limits remain explicit. Sample max32-grain and combined source
profiles have exceeded the quantum budget; the full multiband fixture also retains
measured deadline misses despite its graph-size reduction. Native-loop spectral optimization
reduces graph expansion, but historical cold-start and large-frame watchdog
failures are retained. No maximum-capacity, long-IR, larger-frame or hardware
real-time clearance follows from these small browser compositions.

Local socket restrictions or a missing browser binary are recorded as blocked
browser stages, not successful tests. The historical initial runtime remains
NOT_CLEARED. Full exact-head CI, independent review, completed post-Ready automated review
and issue resolution precede
merge; this document itself does not certify that a pending run has completed.

## Original catalog coverage and next lanes

| Original group | Current boundary / remaining work |
| --- | --- |
| 1. Wavetable / VA / unison | Sine/saw/unison plus resident wavetable, pulse/triangle and seeded-noise candidates. Host-prepared pitch-band tables are included with explicit interpolation-image limits; richer table materials and higher-order antialiasing remain |
| 2. FM / PM / additive / resonators | Bounded candidates included above with independent tuning/sideband/decay and alias evidence. General antialiasing or maximum-capacity real-time support is not implied |
| 3. Sample / multisample / granular | Resident one-shot/loop/reverse/slice playback, fixed mapped zones/grain pools, and separate unity-sum loop crossfades with shortened L-F period are included. Bounded native graph-input take recording is included; microphone/device capture, rolling recording, streaming and general stretch remain |
| 4. Voice / note / expression | Existing voice policy and sustain/glide/tuning wrapper plus manually configured lower-zone member/master expression routing. Full MPE zone/RPN negotiation, master pedals and hardware delivery remain |
| 5. Modulation / sequencing | Initial LFO/follower plus bounded MSEG, held/correlated seeded modulation, clock/step and fixed-note native MIDI arp candidates. Bounded octave-periodic pitch-control quantization with explicit hysteresis is included. No transport synchronization, chord capture, or external host/device delivery claim |
| 6. Filters / EQ / formants / crossover | Clean candidate modules above. Bounded nonlinear character filter included. Broader resonator variants and analog-model/zero-delay solver claims remain separate |
| 7. Drive / waveshaping / reduction | Direct/ADAA fixed curves, native editable 2..17-point curves and fixed 2×/4× memoryless oversampling included, with filtered-dry/bandwidth/phase tradeoffs. General arbitrary-graph oversampling and higher-order AA remain |
| 8. Delay / modulation / frequency shift | Existing Delay/Chorus plus new candidates above. Bounded Hilbert additive-Hz shifter included with a useful-band limit. Fixed dual-head delay-time transitions are included with explicit queue/crossfade semantics; this is not general pitch/time processing |
| 9. Dynamics / limiter / multiband | Single-band dynamics, bounded lookahead/sample-peak limiter and phase-compensated three-band dynamics included. True-peak certification and universal multiband real-time performance are not inferred |
| 10. Reverb / convolution / special tail | Small algorithmic FDN above. Small fixed-IR convolution included with explicit block latency. Prepared-spectrum B128/P64 extends to8192 taps (170.67ms at48kHz) for bounded body/cabinet/short-space use. Controlled four-line FDN freeze/thaw is included with finite-precision limits. Arbitrary long-room support, hybrid and shimmer remain |
| 11. Pitch / time / STFT | FFT/STFT identity extends through N1024 with persistent scheduling/restore phase. Bounded two-window input pitch shift is included with measured coloration/cancellation limits. Framewise spectral gating is included with calibrated linear bin thresholds and explicit ringing/tail limits. Separate bin-centered spectral freeze captures and rotates frames into an explicitly N-periodic texture, not transparent sustain. A bounded sparse resident WSOLA experiment adds independent duration and local-pitch controls, but general time-stretch quality remains incomplete; transparent/stereo/streaming stretching and phase-vocoder capabilities remain |
| 12. Concrete chains / blend | Initial instrument→Delay/drive→dynamics plus glass dyad, FM/modal hit, granular cloud and shaped echo. Fixed gains, phase/latency/tails are explicit; more combinations remain possible |
| 13. Sounds / configurations / materials | Initial five settings remain intact. Four new A/B compositions with original assets and candidate provenance are included; grouped A/B browser audition is staged at `/catalog.html` with its own lifecycle/gain gate, and new human listening/golden approval is not implied |

A missing advanced technique does not stop independently implementable catalog
work. A module name does not count as completed capability without its stated
contract and numerical/package evidence. Broader research and runtime limits are
kept separate from the useful, verified candidate surface.

The grouped [catalog audition](catalog-audition.md) exposes the four A/B musical
examples separately from the initial sounds. Its functional browser checks and
visible unity-default gain do not promote runtime or human-listening acceptance.

## Transition and expression browser boundary

`tests/transitions-browser.test.mjs` builds a small five-output public composition
(two-times drive, fixed-head delay, 2048-sample pitch windows and N256 STFT) plus
a separate one-voice/two-member MIDI composition. Native controls must produce
the independent FIR phase/gain, fixed-delay phase, coherent doubled/halved pitch,
STFT identity and member/master pitch/amplitude equations. Reset silences the
DSP graph; native snapshot restoration is checked as a parameter path, while
exact buffer/history/hop-phase continuation remains proved offline. Expression
checks distinguish current live transient state from fresh-instance defaults.
A cold live restore uses explicit native composition reset before the next fresh
note; unreset held notes/controllers deliberately remain current. This is 48-kHz functional evidence, not maximum-capacity,
all-device deadline, arbitrary-input pitch quality or full MPE acceptance.

The transition browser gate also loads a small two-frame prepared pitch-band
asset, checks independent low-harmonic interpolation gains and high-pitch folded
harmonic rejection, edits the native frame, rejects short asset playback, and
restores PCM/parameters before a held-reset phase check. The cycle-local reader
precision repair is shared by both wavetable readers; rejected prior readers and
actual tiny-phase/full-range counterexamples remain in nonshipping tests.

The framewise [spectral gate](spectral-gate-entry.md) adds one bounded spectral
operation without changing no-hook STFT output or schema. Its small browser
composition checks native threshold/floor edits, all-pass/fixed-floor/closed
limits, rendered-parameter restore and reset against exact delayed-source
phase/gain. These functional limits supplement, rather than replace, the
independent active-bin DFT/WOLA and arbitrary-phase continuation tests. The
corrected candidate drains2N zeros; the original N-drained artifact is retained
as superseded evidence, not presented as the completed effect tail.

## Prepared tails and loop browser boundary

`tests/tail-assets-browser.test.mjs` sends a full host-prepared8192-tap packet
through the native message path, checks the independent delayed FIR complex
transfer, rejects malformed metadata, unloads, replaces with a shorter IR,
restores native coefficients/history, and resets/restarts. The small resident
loop fixture compares every observed output sample to an independent scalar
phase/overlap equation for forward, reverse and fractional playback, and checks
shorter/empty replacement, held-gate invalidation, native asset/state restore
and reset/release. AudioContexts are suspended for synchronous multichannel
observation, then resumed; no alternate renderer or snapshot wrapper is used.
The three-rate offline gate and prior maximum-capacity component proofs remain
separate from this actual48-kHz browser functional boundary.

Prepared convolution requires unchanged certified host packets and normalized
input; native header/number scans do not certify arbitrary supplied spectra.
Preload while audible playback is gated off. Its cold/warm deadline misses remain
recorded. A loop overlap changes the effective duration and can cancel or smear
material; no antialiasing, universal seam removal, recording or streaming follows.


## Native take and frozen-tail browser boundary

`tests/capture-freeze-browser.test.mjs` adds two small actual 48 kHz worklets.
The recorder receives a synthetic native signal, not a microphone. A graph-side
length limit makes 64/128-frame capture and pause deterministic; a limit above
capacity proves the recorder's own 256-frame hard stop. The test checks segment
boundaries, playback through the existing sample player, overwrite/reset, restored
PCM and functional player readback, and loaded-prefix/recorded-suffix interpolation. A browser
Analyser window covers complete 256-frame periods for the playback mean.

Two independently instantiated frozen-tail subgraphs receive identical signals
until only one receives a new disturbance. Their nonzero outputs remain exactly
paired while fully frozen, separate again after thaw/reset, and recover a saved
paired nonzero history through native in-place restoration after every saved
control has actually rendered. The pre-restore pair must still differ, proving
that control synchronization did not reset away the mutation. Freeze amount and
frozen flags, unforced thaw decay, held reset and empty-tail freezing are checked
separately. The browser windows do not claim indefinite energy conservation or
sample-aligned waveform continuation; independent offline energy/state oracles
remain the evidence for those narrower numerical properties.

The installed consumer also renders both compositions at 44.1/48/96 kHz before
bundling. Browser execution must pass on the exact final head in hosted CI. These
checks introduce no capture permission, device bridge, storage service or runtime
clearance. Logical clearing of either storage does not securely erase old bytes.


## Experimental resident stretching boundary

`/resident-time-stretch` is a deliberately limited experiment, not a recommended
realtime default or completion of the time-stretch category. Independent review
found and corrected the exact rational EOF calculation: a 147-frame/44.1 kHz
resident at 48 kHz now has exactly 80/160/320 active frames for scales .5/1/2.
Active duration is not guaranteed nonzero or audible duration. A measured padded
edge lost most of the intended carrier (about .00145 versus .5 in its supported
interior), and a separate dominant-frequency example deviated by +3 Hz.

The final maximum graph is approximately 315 KB / 52,040-byte WASM with fixed
4,521,984-byte native memory. Independent packed timing observed 49.90 ms cold
and 21.84 ms warm maximum. An actually loaded maximum graph observed 2.385 ms
median and 7.927 ms maximum; all 256 measured quanta exceeded the 0.667 ms
budget at 192 kHz. These supplement earlier lower measurements. **NOT_REALTIME**
and **CANDIDATE** remain mandatory; mathematical correctness is not musical
quality, listening approval or hardware capacity clearance.

`tests/stretch-browser.test.mjs` requires actual 48 kHz native resident ingress,
exact active counts and first-EOF timing at both pitch settings, and an independent
scalar accumulation of rendered audio. A separate coherent, source-supported
interior checks latched parameter edits, retriggered frequency, exact EOF, held-
gate replacement cancellation, and in-place restoration of noninitial source
time plus PCM. Those selected interiors do not hide or supersede the retained
edge, arbitrary-tone, alias and cost counterexamples. Native three-rate exact
rational composition and public type/build checks precede the hosted browser
gate. Bit-exact quantum continuation remains separately verified offline.

The initial hosted PR38 and stacked PR39 gates exposed a real live-restore
ordering limitation: restored state can process under old AudioParams before
the host restores those values. Both measured paired-left residual
0.2498931884765625. An independent native one-quantum stale-control reproduction
matched that exact value; rendering saved controls before restoration recovers
bit-identical histories at all three rates, including poisoned transient scratch.
The deterministic negative-gap regression remains in the packed gate. The raw
browser attempt is retained as an observation, not required to race on every
schedule. This is documented caller coordination, not atomic restore support.


The inherited transitions browser probe exposed the same non-atomic control
boundary with a different lasting effect. At a 48 kHz / 375 Hz coherent input,
one stale ratio=.5 quantum advances the two-window pitch phase by 1/32, moving
read ages by 64 samples and permanently inverting the later unity-ratio output.
Independent native restoration with odd stale-quantum counts reproduces the
observed real-bin +0.006133459294852017 instead of -0.006133459294851527; even
gaps can appear correct. The negative-gap regression retains both cases.

The transitions fixture now renders all five saved ratio/time/gain/mix/reset
controls before restore and verifies them exactly through native telemetry,
including the small f32 delay-seconds value. It does not reset or retrigger the
pitch effect to hide phase state; all original complex phase/gain assertions
remain. MPE transient-state and instrument observer-clock findings stay separate.

The sustained instrument observer also separates published clock metadata from
captured samples. A failing and passing hosted 12-second WAV were byte-identical
despite repeated/skipped `currentFrame` values. The revised observer captures a
separate native buffer-source ramp and requires exact per-sample progression,
128-sample block lengths and 576,000 total samples, including silence. Its audio
oracle now predicts the complete steady interval with the original amplitude,
continuity and tail tolerances. Negative duplicate/drop/reorder/zero/short-block
controls verify those assertions. Raw clock anomalies remain explicit
`CLOCK_METADATA_ANOMALY_REQUIRES_REVIEW` findings; neither this observation fix
nor a numerical pass clears hardware or real-time acceptance (`NOT_CLEARED`).

## Musical quantization and spectral capture browser boundary

`tests/quantized-freeze-browser.test.mjs` uses actual native 48 kHz control/audio
outputs. Two three-degree quantizers compare nearest selection with inclusive
hysteresis, adjacent f32 boundary values, negative octaves and held reset. A saved
upper degree at the exact midpoint is contrasted with a fresh lower-nearest
selection after mutation. Saved controls are rendered before restoration; the
selected degree must remain different until persistent state is restored.

The small N64/H16 spectral graph captures constant input. Positive bin rotations
circularly shift the captured analysis window. Its steady held waveform therefore
has an independent closed-form, nonconstant N-periodic envelope, checked sample
by sample up to an unknown integer cyclic phase. A constant output, fitted RMS or
changed amplitude cannot substitute for this waveform. Live identity, held input
changes, latest-input release, a negative recapture and guarded recovery of the
original positive capture are checked separately. Native telemetry verifies the
saved controls while the negative capture is still present; reset and empty hold
are also required. Three-rate native composition/public type/build checks precede
actual browser execution. Exact full-state continuation stays independently
verified offline.

These are small functional graphs. Maximum 128-degree quantizer timing varied
from p50/p99/max 2.04/16.19/152.4 ms in one run to .60/4.91/10.31 ms in a later
run; both remain evidence, with no realtime clearance. Spectral freeze retains
strong captured-window modulation, colored off-bin textures, possible increased
peaks and no finite drain while held. Its ideal 2*sqrt(N) bound is not a limiter
or a finite-precision theorem. All audio remains CANDIDATE, with no new human
listening approval or completed general spectral/time-processing claim.
