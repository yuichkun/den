# Integrated sound audition: numerical headroom

Status: **CANDIDATE**. Offline numerical checks do not clear the real-time gate,
constitute human listening approval, or authorize production deployment.

## Scope and reproduction

`tests/integration-consumer/sound-matrix-render.mjs` runs in the isolated consumer
installed from `npm pack`, using public `@denaudio/den/instrument` and
`@denaudio/den/delay-fx` imports. `tests/integration.test.mjs` invokes it after the
existing diagnostic renderer, which remains unchanged. No package DSP, public
sound settings, gains, or normalization are altered by this audition.

At 48 kHz it renders all four instruments through diagnostic delay, Chorus, and
Rhythmic Delay. Each source runs through the FX defaults, dry mix, and maximum
wet mix with feedback 0.5. The ten source traces produce 90 stereo FX rows:

- Every displayed note at MIDI velocity 127, followed by note-off, retrigger
  during release, and verified exact source silence after the final release.
- The main hold button for every instrument, including each polyphonic chord.
- Overlapping notes and last-held-note return for the mono instruments.
- Four coherent, same-pitch voices at **every displayed pitch** for Diagnostic
  and Pad, followed by release. This is stronger than the UI's velocity 100.
- Pad holds exceed its 0.8 s attack + 1.2 s decay + one complete 8.333... s LFO
  period. This applies separately to the chord and every coherent pitch.
- Live FX history between register steps and six additional seconds after each
  complete trace, exposing accumulated echoes and release tails.

The traces contain 205.848 seconds of source audio. The initial standalone run
completed in about 93 seconds on the cloud executor. This is test duration, not
real-time performance evidence.

The script writes `integration-sound-matrix.json`, including all settings, MIDI
events, time windows, source/output peak and RMS, output headroom, release/end-tail
measurements, scrub/nonfinite/clipping counts, reference errors, and bounds. It
also writes twelve `sound-matrix-{instrument}-{effect}.wav` files: main-button
holds at each FX's defaults, unnormalized at Master 1, with SHA-256 hashes.
These files are listening **candidates**, never expected audio or golden files.

## Independent checks and bound

Each FX sample is compared with an independent unbounded-timeline delay oracle.
The oracle uses a direct-form bilinear biquad rather than the production
circular buffers and state-variable-filter recurrence, and evaluates the
Chorus modulation and stereo phase separately. Maximum sample error is limited
to `6e-6`; the observed worst error was `2.1909363568e-6`.

Every render must have zero scrubbed samples, zero nonfinite output, and zero
samples at or above full scale. Dry output must be bit-identical to its source.
Deliberately clipped, nonfinite, and above-ceiling fixtures verify that the
numerical guards reject invalid material.

The test first enforces explicit per-instrument **source regression ceilings**:

| Instrument | Source ceiling | Rationale |
| --- | ---: | --- |
| Diagnostic | 0.20001 | Four 0.05-gain voices, small numerical margin |
| Bass | 0.24 | Twice the 0.12 raw gain allows resonant/transient overshoot |
| Percussion | 0.16001 | One 0.16-gain voice, small numerical margin |
| Pad | 0.18001 | Four 0.045-gain voices, small numerical margin |

These are independently chosen numerical guards, not a theorem about every
possible MIDI schedule or every time-varying instrument filter. Bass actually
reaches 0.12384, demonstrating why raw gain alone is not a sufficient bound.

For a recorded source peak M, mix m, and feedback f, the FX bound is:

`M * ((1 - m) + m / (1 - f)) * Master + 1e-6`

This bound is independent of the rendered FX peak. All three feedback paths
are flat or fixed Q=0.5 low-pass; their nonnegative impulse responses have unit
L1 norm at the candidate cutoffs. Interpolated delay, including Chorus's moving
readheads, cannot increase the supremum. Therefore f <= 0.5 permits at most a
factor of two. The oracle asserts valid timing and unclipped modulation.

With **Master range 0–1, default 1**, the largest fixed source ceiling yields
an FX ceiling below 0.480001. Every output is also required to stay below the
separate **0.5 ceiling**, preserving at least 6.02 dB to full scale for tested
material. This explicitly replaces reliance on the prior diagnostic-only 0.8
limit. No limiter or normalization is inserted.

## Measured maxima

Maximum absolute sample across all scenarios and controls at Master 1:

| Instrument | Raw source | Diagnostic delay | Chorus | Rhythmic Delay |
| --- | ---: | ---: | ---: | ---: |
| Diagnostic | 0.187219307 | 0.276219070 | 0.368202865 | 0.326295972 |
| Bass | 0.123841561 | 0.163044527 | 0.205227017 | 0.176587388 |
| Percussion | 0.158914849 | 0.213010132 | 0.240000606 | 0.219704628 |
| Pad | 0.168394074 | 0.208122611 | 0.312585205 | 0.228740290 |

All 90 rows passed. The worst output, **0.368202865**, is Diagnostic → Chorus,
four coherent voices across the displayed register, wet mix 1 and feedback 0.5.
It leaves **8.678 dB** of measured headroom. Every render had zero scrubbed,
nonfinite, or clipped samples.

Master 2 would not clip these particular recorded samples, but would exceed the
chosen 0.5 regression ceiling and surrender 6.02 dB of output margin. The
integrated candidate therefore keeps Master 0–1 without changing public sound
parameters. The matrix does not establish a universal arbitrary-MIDI safety
proof, real-time capacity, device playback behavior, or physical listening
approval; those remain separate checks.
