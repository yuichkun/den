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

Contracts, controls and limitations are detailed in [filters](catalog-filters.md),
[dynamics](dynamics.md), [drive](drive.md), [modulation/reverb](catalog-modulation-fx.md),
[sources/resonators](sources.md), and [control modulation](control-modulation.md).
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

Local socket restrictions or a missing browser binary are recorded as blocked
browser stages, not successful tests. The historical initial runtime remains
NOT_CLEARED. Full exact-head CI, independent review and issue resolution precede
merge; this document itself does not certify that a pending run has completed.

## Original catalog coverage and next lanes

| Original group | Current boundary / remaining work |
| --- | --- |
| 1. Wavetable / VA / unison | Existing sine/saw and bounded sine/saw unison candidate. Wavetable/frame assets, pulse/triangle and higher-order antialiasing remain separate work |
| 2. FM / PM / additive / resonators | Bounded candidates included above with independent tuning/sideband/decay and alias evidence. General antialiasing or maximum-capacity real-time support is not implied |
| 3. Sample / multisample / granular | Resident PCM ingress and fixed sample/multisample/granular playback are the next lane; maximum memory/compile budget, replacement and interpolation semantics must pass before inclusion. Loop crossfade and live/streaming input remain separate |
| 4. Voice / envelope / expression | Initial voice/ADSR available. Sustain, glide, pressure/MPE and broader tuning are separate extensions |
| 5. Modulation / sequencing | Initial LFO/follower plus bounded MSEG, held/correlated seeded modulation, clock/step and fixed-note native MIDI arp candidates. No transport synchronization, chord capture, or external host/device delivery claim |
| 6. Filters / EQ / formants / crossover | Clean candidate modules above. Nonlinear character filters and broader resonator variants remain distinct |
| 7. Drive / reduction / AA | Fixed curves and applicable first-order ADAA above. Oversampling, arbitrary user curves/LUT and higher-order AA are not claimed |
| 8. Delay / modulation / frequency shift | Existing Delay/Chorus plus new candidates above. Frequency shifting and dual-head pitch-preserving transitions remain distinct |
| 9. Dynamics / limiter / multiband | Single-band candidates above. Lookahead, true-peak certification and multiband are not inferred |
| 10. Reverb / convolution / special tail | Small algorithmic FDN above. Bounded fixed-IR convolution is an active separate FFT lane; hybrid/freeze/shimmer remain |
| 11. Pitch / time / STFT | Small FFT/STFT identity and bounded scheduling are an active separate lane; spectral processing, pitch/time and WSOLA/phase-vocoder capabilities remain |
| 12. Concrete chains / blend | Initial instrument→Delay and packed drive→dynamics examples. Musical chains and latency/phase/tail interactions expand with reviewed modules |
| 13. Sounds / configurations / materials | Initial five settings remain intact. New meaningful sound examples/materials require their own provenance and later grouped listening evaluation |

A missing advanced technique does not stop independently implementable catalog
work. A module name does not count as completed capability without its stated
contract and numerical/package evidence. Broader research and runtime limits are
kept separate from the useful, verified candidate surface.
