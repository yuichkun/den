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
| 3. Sample / multisample / granular | Bounded resident PCM, one-shot/loop/reverse/slice, first-match multisample and seeded fixed-pool grains included. Loop crossfade, stereo/live recording, read/write-age rules and streaming remain |
| 4. Voice / note / expression | Existing voice policy and sustain/glide/tuning wrapper plus manually configured lower-zone member/master expression routing. Full MPE zone/RPN negotiation, master pedals and hardware delivery remain |
| 5. Modulation / sequencing | Initial LFO/follower plus bounded MSEG, held/correlated seeded modulation, clock/step and fixed-note native MIDI arp candidates. No transport synchronization, chord capture, or external host/device delivery claim |
| 6. Filters / EQ / formants / crossover | Clean candidate modules above. Bounded nonlinear character filter included. Broader resonator variants and analog-model/zero-delay solver claims remain separate |
| 7. Drive / waveshaping / reduction | Direct/ADAA fixed curves, native editable 2..17-point curves and fixed 2×/4× memoryless oversampling included, with filtered-dry/bandwidth/phase tradeoffs. General arbitrary-graph oversampling and higher-order AA remain |
| 8. Delay / modulation / frequency shift | Existing Delay/Chorus plus new candidates above. Bounded Hilbert additive-Hz shifter included with a useful-band limit. Fixed dual-head delay-time transitions are included with explicit queue/crossfade semantics; this is not general pitch/time processing |
| 9. Dynamics / limiter / multiband | Single-band dynamics, bounded lookahead/sample-peak limiter and phase-compensated three-band dynamics included. True-peak certification and universal multiband real-time performance are not inferred |
| 10. Reverb / convolution / special tail | Small algorithmic FDN above. Small fixed-IR convolution included with explicit block latency. Musical long-IR support, hybrid/freeze/shimmer remain |
| 11. Pitch / time / STFT | FFT/STFT identity extends through N1024 with persistent scheduling/restore phase. Bounded two-window input pitch shift is included with measured coloration/cancellation limits. Spectral transforms, independent time stretch, WSOLA and phase-vocoder capabilities remain |
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
restore must clear transient notes and gestures, silence orphan DSP, then accept
a fresh member note. This is 48-kHz functional evidence, not maximum-capacity,
all-device deadline, arbitrary-input pitch quality or full MPE acceptance.

The transition browser gate also loads a small two-frame prepared pitch-band
asset, checks independent low-harmonic interpolation gains and high-pitch folded
harmonic rejection, edits the native frame, rejects short asset playback, and
restores PCM/parameters before a held-reset phase check. The cycle-local reader
precision repair is shared by both wavetable readers; rejected prior readers and
actual tiny-phase/full-range counterexamples remain in nonshipping tests.
