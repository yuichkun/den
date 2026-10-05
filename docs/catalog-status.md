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
| Flanger/phaser, ping-pong/multitap delay, small algorithmic FDN | `/modulation-fx`, `/stereo-delay`, `/reverb` | Three-rate impulse, modulation energy, timing, stereo, tail/decay and packed Vite evidence; final independent review and integration gates govern acceptance |

Contracts, controls and limitations are detailed in [filters](catalog-filters.md),
[dynamics](dynamics.md), [drive](drive.md) and [modulation/reverb](catalog-modulation-fx.md).
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

Local socket restrictions or a missing browser binary are recorded as blocked
browser stages, not successful tests. The historical initial runtime remains
NOT_CLEARED. Full exact-head CI, independent review and issue resolution precede
merge; this document itself does not certify that a pending run has completed.

## Original catalog coverage and next lanes

| Original group | Current boundary / remaining work |
| --- | --- |
| 1. Wavetable / VA / unison | Existing sine/saw; bounded unison is a separate source lane. Wavetable/frame assets, pulse/triangle and higher-order antialiasing remain separate work |
| 2. FM / PM / additive / resonators | Separate source/resonator lane; fixed capacities, tuning/sidebands/decay and alias limitations must be tested before integration |
| 3. Sample / multisample / granular | Asset/buffer entry proof and fixed-capacity playback/grain semantics remain |
| 4. Voice / envelope / expression | Initial voice/ADSR available. Sustain, glide, pressure/MPE and broader tuning are separate extensions |
| 5. Modulation / sequencing | Initial LFO and new follower; bounded MSEG, seeded held/correlated modulation and musical clock/step lane is separate. Native MIDI output must be proven before arp claims |
| 6. Filters / EQ / formants / crossover | Clean candidate modules above. Nonlinear character filters and broader resonator variants remain distinct |
| 7. Drive / reduction / AA | Fixed curves and applicable first-order ADAA above. Oversampling, arbitrary user curves/LUT and higher-order AA are not claimed |
| 8. Delay / modulation / frequency shift | Existing Delay/Chorus plus new candidates above. Frequency shifting and dual-head pitch-preserving transitions remain distinct |
| 9. Dynamics / limiter / multiband | Single-band candidates above. Lookahead, true-peak certification and multiband are not inferred |
| 10. Reverb / convolution / special tail | Small algorithmic FDN above. Convolution needs framing/FFT entry proof; hybrid/freeze/shimmer are separate |
| 11. Pitch / time / STFT | FFT/framing, identity reconstruction and bounded scheduling need their own implementation/evidence |
| 12. Concrete chains / blend | Initial instrument→Delay and packed drive→dynamics examples. Musical chains and latency/phase/tail interactions expand with reviewed modules |
| 13. Sounds / configurations / materials | Initial five settings remain intact. New meaningful sound examples/materials require their own provenance and later grouped listening evaluation |

A missing advanced technique does not stop independently implementable catalog
work. A module name does not count as completed capability without its stated
contract and numerical/package evidence. Broader research and runtime limits are
kept separate from the useful, verified candidate surface.
