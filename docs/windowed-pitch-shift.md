# Bounded moving-window pitch effect

`windowedPitchShift` from `@denaudio/den/windowed-pitch-shift` is a CANDIDATE
mono input pitch effect made entirely from the existing unworklet 0.4.1 graph,
native controls, fixed buffers and snapshots. It changes the read speed of a
continuously arriving input. It does not reuse or change `dualHeadDelay`.

## Entry and allocation

Instantiate with `sampleRate: ctx.sampleRate` (integer 8000..192000) and optional
`windowSamples` (even integer 32..16384, default 2048). This fixes the delay-sweep
width W and allocates W+3 f64 history values, or 8(W+3) bytes excluding native
driver overhead. No resizing, runtime asset load, FFT or second audio runtime.

Call `tick(input, { ratio, retrigger, reset })` exactly once per sample. It returns
`{ output, ratioRejected }`. Input must be finite f32; all finite magnitudes,
including subnormals, are supported through exact binary internal scaling.
`ratio` is an audio-rate f32 input-time speed in [0.5,2], corresponding to one
octave down/up. NaN, infinities and adjacent out-of-range f32 values are rejected,
leaving the last valid ratio unchanged. Initial ratio is 1. There is no implicit
smoothing or semitone conversion; hosts may compose those explicitly.

## Exact sample law, latency and gain

Before consuming input x[n], let p be the stored phase in [0,1). Read the existing
history at delays dA=1+Wp and dB=1+W frac(p+1/2), using linear interpolation and
zero for unavailable history. The A weight is 1-|2p-1|; B uses its exact complement.
The emitted sample is their weighted sum. Store x[n] after reading, then advance
p by (1-ratio)/W modulo one. Between head wraps, input time therefore advances
by `ratio` samples per output sample. A head wraps only at its zero-weight point;
this does not make arbitrary input, retrigger or parameter edits click-free.

W denotes delay excursion, not a fixed-duration grain or STFT frame. At constant
nonunity ratio, one head cycle lasts W/|1-ratio| output samples; the other is a
half-cycle away. A large W lowers that window modulation rate and raises delay.
Ratio 1 stops phase movement rather than resetting it.

All reads have ages between 1 and W+1 samples. There is no single fixed latency
for pitch-shifted audio. Initially (or after a phase retrigger), ratio 1 gives an
exact 1+W/2-sample delay: at default W=2048 this is 1025 samples, about 21.35 ms
at 48 kHz. Returning to ratio 1 after arbitrary modulation freezes two weighted
different delays, which can comb-filter or cancel; it is not transparent bypass.
Mixing with dry audio adds phase coloration. The caller owns mixing and any
alignment decision; neither a dry tap nor automatic level compensation is hidden.

Both the interpolation and crossfade are convex. Output peak cannot exceed the
largest absolute retained input sample (up to floating rounding). Once history
is full, constant input passes at exactly unity gain. There is no feedback. If
the final nonzero input is at n, output is zero from n+W+2 onward, under every
ratio/retrigger sequence. An impulse may be repeated, attenuated or skipped.

## Reset, retrigger and state

`reset` has priority. It silences the current sample, discards that input,
invalidates history without clearing the entire allocation, and holds phase and
write cursor at zero. Held reset remains silent. The first sample after release
starts at phase zero with empty history. During reset a valid ratio is accepted;
an invalid ratio falls back to 1 instead of preserving the pre-reset value.

`retrigger` rephases the current read to zero while retaining existing history
and the current valid ratio. The sample then advances normally. A held retrigger
uses the initial midpoint delay every sample, even when ratio is not 1. An
instantaneous rephase can click; this is an explicit articulation control, not a
crossfade or automatic note policy.

History, cursor, valid age, phase and last valid ratio are native persistent
state. The output temporary is transient. Restoration is supported only for the
same processor, schema, configuration and sample rate; no cross-schema migration
is provided. Capture rendered native controls, not pending suspended edits.

## Audible limits and verification boundary

Linear interpolation is not a bandlimited resampler. Upward transposition of
content above sampleRate/(2*ratio) folds across Nyquist; even lower inputs can
show interpolation images and window sidebands. The two windows can color,
amplitude-modulate, smear, repeat, skip or cancel material, especially transients
and tones whose periods do not fit W. Window size and ratio are audible design
choices, not quality guarantees. There is no formant preservation, transient
alignment, WSOLA, phase vocoder or general independent duration/time stretching.

The dominant output pitch need not equal ratio times input pitch for undersized
or noncoherent windows. For example, W=64, ratio=2 and input
`0.75*cos(2*pi*n/128)` cancel the desired doubled-frequency bin (1/64 cycles per
sample, measured amplitude about 1.1e-16), while the original-frequency bin
(1/128 cycles per sample) remains at about 0.608049 amplitude. This measured
window limitation also means a larger/default W is not a pitch-quality guarantee.

Tests use an independent unbounded absolute-input timeline, analytic coherent
sinusoid frequency/phase checks, retained cancellation and alias counterexamples,
endpoint and gain bounds, reset/retrigger and in-flight same-schema continuation
at 44.1/48/96 kHz offline. The isolated packed consumer checks public declarations,
native per-sample ratio controls and fixed maximum allocation. Local timing is
diagnostic only. No browser/hardware realtime deadline, human listening approval
or golden-audio status follows from these tests.
