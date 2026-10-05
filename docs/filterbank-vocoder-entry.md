# Fixed filter-bank vocoder candidate

Catalog group 11 explicitly includes a filter-bank vocoder. This entry is a bounded native implementation on unworklet 0.4.1, using the reviewed den TPT state-variable filter and peak envelope follower. It is independent of the STFT/phase-vocoder processors. It does not claim speech intelligibility, commercial equivalence, or human-approved sound quality.

## Contract

`filterBankVocoder({ sampleRate, bands })` constructs a mono processor. `sampleRate` is an integer from 8,000 through 192,000 Hz and must equal the actual processing rate. `bands` is a dense array of 1–8 `{ frequencyHz, q, gain }` records. Centers must be strictly increasing, from 20 Hz through `min(20000, .45 * sampleRate)`; Q is .5–10 and gain is a nonnegative linear factor from 0–4. Invalid values, empty/oversized/sparse arrays, duplicate centers and descending centers reject at graph construction. Values are copied into the graph; mutating the configuration later does not retune it. Structural changes require a new graph.

For every band, one second-order unity-peak bandpass analyzes the modulator, and an identical second-order bandpass filters the externally supplied carrier. The center/Q controls use the existing SVF's f32 rounding, bounds, and bounded coefficient approximation. There is no automatic logarithmic placement, channel adaptation, unvoiced/noise source, high-frequency bypass, or crossover-perfect reconstruction claim.

`tick(modulator, carrier, { attack, release, reset })` is called exactly once per sample. It returns `{ output, envelopes }`, with envelopes in configuration order. All sample operations and persistent histories are native unworklet graph operations. JavaScript loops construct the graph; they do not process audio on the host.

For band `i`, the output is exactly the implemented f32 endpoint of:

    analysis_i = BP_i(modulator)
    carrier_i = BP_i(carrier)
    target_i = abs(analysis_i)
    envelope_i = previous_i * (1 - coefficient) + target_i * coefficient
    output = sum_i(gain_i * carrier_i * envelope_i)

The recurrence uses f64 history, the exposed envelope and bandpass endpoints are f32, and the output sum uses f64 before its f32 endpoint. No hidden band-count division, automatic gain control, peak/RMS calibration, makeup gain, clipping, or limiter is present. Gains of zero still process the band's history. Parallel bands overlap and have phase, so their sum is not a flat unity transfer. A constant carrier gain does not imply a constant output gain.

## Envelope and gain interpretation

The peak follower here smooths rectified amplitude, not windowed peaks or RMS. Attack is selected when the current target exceeds previous envelope; otherwise release is selected. Each time is in seconds, clamped to 0–30; nonfinite times become zero. Zero time is immediate. A positive time uses `tauSamples = max(1, seconds * sampleRate)` and `coefficient = 1 - exp(-1 / tauSamples)`, with the reviewed bounded polynomial implementation. One time constant traverses approximately 63.2% of a constant target difference. Filter ringing also affects a band envelope after a burst.

For a center-frequency sine of amplitude A, the unity-peak filter preserves the settled sine amplitude. Under equal, slow attack/release, the envelope approaches the sampled rectified mean with ripple. `2A/pi` is the ideal continuous-time rectified-sine mean, not an exact finite sampled mean or a calibration applied by this module. Unequal attack/release can produce a different average. With both times zero, the envelope is the instantaneous absolute band sample. The user-specified gains control synthesis level explicitly.

Finite input is not clipped, including values above full scale. Nonfinite modulator/carrier samples become zero before entering their filters; earlier finite filter/envelope histories continue. The caller must provide practical headroom: finite extreme inputs/products/sums can exceed f32 output range. There is no arbitrary-overload guarantee. Ordinary IEEE product underflow can occur at tiny levels even though reused filter/follower history scaling preserves their respective histories.

## Reset and persistence

Reset clears both bandpass integrators and the envelope history before the current sample. The current sample is still processed; reset is not an output mute. Holding reset high recomputes the first-sample response for each input. It does not switch off processing.

All histories live in unworklet state under stable per-band analysis/synthesis/envelope names. Same-schema snapshot/restore continues filter ringing and envelopes. Tests must compare noninitial continuation, output and final state, including quantum boundaries. No custom snapshot codec or migration is introduced. Changing band count/order/centers/Q/gain or sample rate is a new configuration; cross-configuration restore compatibility is not promised.

Core 0.4.1 restores persistent worklet state before the host restores saved
AudioParams. In-place restoration across different live controls is not atomic.
The browser composition renders every saved control before calling restore.
It saves a nonzero slowly decaying envelope with zero modulator input, clears
the live history, then proves that the stable saved controls leave that mutation
silent. Restoration must recover both the envelope and actual carrier output.
Measured native-clock brackets bound the expected 30-second exponential decay,
with eight quanta allowed for delivery/publication and analyser alignment. This
is an observation allowance, not increased DSP accuracy or restored timing;
exact sample-aligned filter/history continuation remains an offline assertion.

There is no block lookahead or explicit delay buffer. Filter phase and attack/release cause frequency-dependent temporal response, so this is not a zero-phase or transient-transparent effect.

## Validation boundary

The targeted gate checks 44.1/48/96 kHz against independent RBJ direct-form-I bandpasses and a direct exponential envelope recurrence, plus center transfer, out-of-band rejection, carrier modulation, no implicit normalization, malformed configuration, reset-current-sample behavior, held reset, snapshot continuation, and instance isolation. The packed consumer must typecheck the public subpath, render actual native WASM, and compile the worklet with unworklet 0.4.1. Candidate audio, cost data and source/package hashes are evidence, not approved goldens. Browser/realtime, concurrency and listening acceptance remain separate.

The hosted 48 kHz browser gate uses native sine sources and a one-band worklet.
It checks rectified-amplitude calibration, doubled modulation, a silent carrier,
rendered control telemetry, the noninitial restore described above and reset.
It does not establish speech intelligibility or maximum-bank deadline capacity.
The explicit local browser-skip switch is rejected in hosted CI.
