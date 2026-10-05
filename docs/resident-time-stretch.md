# Bounded resident WSOLA time stretching

Status: **CANDIDATE**, catalog §11. `residentTimeStretch` from
`@denaudio/den/resident-time-stretch` changes resident mono duration independently
of grain-local pitch. It is a waveform-similarity overlap-add (WSOLA) variant with
fixed sparse comparison points. This is not a renamed two-head live pitch delay,
a phase vocoder, formant preservation or a transparent general-purpose stretcher.

## Entry, native ownership and cost

Instantiate with `sampleRate: ctx.sampleRate` (integer 8000..192000), an existing
`ResidentSample`, `hopSamples: 128 | 256` (default 256) and
`searchFrames: 0 | 8 | 16 | 32 | 64 | 128` (default 64). H is the synthesis hop in
output frames; the two overlapping source grains each span 2 H output frames.
S is the search radius in source frames. Neither scales automatically with rate.
At 48 kHz the default window spans 10.67 ms and search±64 spans±1.33 ms; these are short
creative windows, especially for bass, speech and complex/polyphonic material.

The asset remains bounded to 1..65536 mono f32 source frames with a fixed
integer source rate 8000..192000 Hz, using the existing native resident ingress. See [sample.md](sample.md)
for delivery, truncation, revision, RAM and callback-copy caveats. Decode and
validate PCM outside audio processing, preload with audible playback gated off,
and establish the delivery boundary before starting. There is no new loader,
streaming path, JS-rendered audio, external WASM or unworklet modification.

Call `tick(controls, everyNSamples)` once per sample inside stride-1 native
`forSample((i, everyNSamples) => ...)`. This module allocates 64 f64 transient
comparison values (512 bytes), fixed scalar state and no length-dependent output
buffer. Resident PCM and ingress allocation are shared, not copied per instance.
Sixteen maximum ingress slots reserve 4 MiB, plus 256 KiB resident PCM.

The graph uses bounded native counted loops, not expanded code per PCM frame or
search candidate. Every 128 output samples it evaluates 64 reference reads and
(2 S+1)×64 candidate comparisons; each comparison uses zero-padded linear sampling.
H256 commits only alternate evaluations. This eager 128 scheduling, including
when stopped, is deliberate: unworklet 0.4.1's native hop counters are not snapshot
state, whereas the module's persistent H clock is. Muting/gate-off does not remove
search cost. S0 still evaluates the zero-offset baseline. Maximum S128 means
16,448 comparisons per 128-sample quantum; there is no average-cost CPU-saving claim.

## Controls, launch and transitions

Controls are `{ gate, trigger, reset, durationScale, pitchRatio }`.

- Gate rise or true trigger requests a launch at the next global H boundary,
  with 0..H−1 samples of request waiting. Controls latch at actual launch, not at
  the request sample. Gate must remain high. A held trigger restarts every hop.
- `durationScale` and `pitchRatio` must each be finite f32 in [0.5,2]. Both latch
  for the whole run; edits alone do nothing. Invalid controls reject that launch,
  clear its request and leave any already-running playback intact. There is no
  implicit clamp, smoothing or fallback transposition.
- A launch resets source/output time to 0. Its first H-sample grain is direct,
  without an artificial fade-in. Later boundaries use overlap. Launch/retrigger
  can click. The resident is read with zero padding on both ends; no loop or
  reverse mode is supplied.
- Gate-off cancels immediately without release/tail. Reset cancels and silences
  its current sample and clears pending launch, EOF and rejection. Held reset
  stays silent; a still-high gate requests a new launch after release.
- Reset does not rephase the global hop. A resident revision immediately cancels
  playback and pending launch. A gate already held high does not silently start
  the replacement, although a new trigger in the same sample can request it.
  Empty/unloaded assets are missing/silent.

## Exact time, search and sample law

Let L be the loaded source length, R the output rate, Rs the fixed source rate,
D the accepted durationScale and P the accepted pitchRatio. A launch has exactly
T=ceil(L×R/Rs×D) active output samples, n=0..T−1. The logical source position is
n×L/T. Thus requested duration rounds upward by less than one output frame, and
pitch never changes T. The largest permitted T is 3,145,728 output frames.
Fractional resident source rates are rejected by this module, without changing the residentSample API.

Duration is an exact rational ceil for integer rates and the accepted f32 D.
The implementation splits L×R×(D×2^24) into exact small integer products and
compares their integer part/remainder to a nearby quotient, avoiding a pre-rounded
rate quotient or an epsilon adjustment. The independent scalar oracle uses
BigInt rational arithmetic. The regression L=147 / Rs=44100 / R=48000 has exactly
80/160/320 samples at D=0.5/1/2; the original pre-rounded-rate calculation wrongly
produced 81/161/321 and is preserved in the initial review evidence.

Grain-local sampling advances q=P×Rs/R source frames per output sample. At each
later synthesis hop the new nominal grain start is n×L/T, independent of P. The
previous grain continues from its selected start plus Hq. Alignment compares that
previous tail with candidate starts nominal+d, where integer d is 0,±1,…,±S.
Each candidate's score is the sum of squared differences at 64 positions
j×H/64, j=0..63, using the same q. Baseline d=0 is first, then +1,−1,+2,−2,…;
strictly smaller cost wins, so exact ties prefer the smallest absolute offset,
then the positive offset. S0 is ordinary overlap-add without alignment.

At local output index k=0..H−1, output is
(1−k/H)×previousTail[k] + (k/H)×newHead[k]. First-hop output is newHead[k]. Each
endpoint outside [0,L) is zero, including fractional intervals [−1,0) and [L−1,L).
Indices are explicitly clamped before resident access; padding is not endpoint
hold, accidental index wrap or stale PCM reuse. EOF outputs silence exactly from
n=T onward, with no post-EOF overlap tail. A late grain may encounter padding
before EOF, so active duration does not imply nonzero PCM at every active sample.
For the 8192-frame, 1/128-cycles/source-frame cosine fixture at D=2/P=2, a late
256-frame region peaks near 0.309 instead of the 0.5 interior amplitude. This is
retained edge attenuation, not corrected by hidden normalization.

Interpolation and overlap weights are convex. Peak is bounded by the largest
absolute finite resident PCM value (within floating rounding), and supported
constant interiors retain unity gain. There is no loudness/peak normalization,
limiter, clipping or implicit dry mix. Nonfinite PCM taps become zero through the
resident contract. Internal exact binary scaling by 2^192 avoids the native tiny
scalar-store scrub during sample/error accumulation. Even the 64-term score for
opposite finite f32 extrema is below 2^649, safely finite in f64; this scaling does
not alter audio gain or relative candidate scores.

Return values are `{ output, active, position, ended, pending, rejected, missing,
selectedOffset }`. `active` refers to the current output sample, including zeros.
`position` is the current logical n×L/T, held at L after EOF; it is not either
aligned readhead's position. `ended` becomes true on the first EOF sample and
stays true until reset/replacement/new launch. Early gate-off does not set EOF.
`rejected` retains the latest launch result until another attempted launch/reset.
`selectedOffset` is the last committed hop's integer d. Rejected and selectedOffset
are diagnostics, not proof that any output was audible.

All launch/clock/time/grain/EOF and resident state use native persistent snapshots;
comparison, score and output scratch are transient. Restoration is bit-identical
only for the same graph, configuration, resident metadata and rate, at the native
quantum boundaries. In particular, H256 halfway-hop and pending launches must
continue exactly after a 128-aligned snapshot. No serializer or migration layer is
introduced.

## Audible and acceptance limits

Linear interpolation is not bandlimited. Pitch-up aliases original source
frequencies above R/(2 P) Hz, or R/(2 P Rs) cycles per source frame.
Interpolation images/attenuation remain below that limit. All pitch/formants move
together, and input frequencies above the destination Nyquist can alias even at
P1 when source/output rates differ.

Sparse waveform matching can choose an unsuitable periodic alignment. Its 64
comparison points do not represent every output sample. Limited S cannot align
long periods or all components of a polyphonic signal. Linear crossfades can
cancel, amplitude-modulate and color tones, especially without alignment; grains
can duplicate, omit or smear transients. Short input and both padded edges receive
only partial windows, and EOF may truncate a window/transient abruptly. No
speech/consonant preservation, stereo coherence or artifact-free claim follows.
Use a separate envelope/crossfade if a click-free articulation is required.

The algorithm is an original bounded implementation of the waveform-alignment
idea described in Driedger and Müller, [A Review of Time-Scale Modification of
Music Signals](https://www.audiolabs-erlangen.de/content/resources/MIR/00_PCD_AudioLabs/2016_DriedgerMueller_TSMOverview_AppliedSciences_ePrint.pdf),
2016, §4. Their descriptions explain the method/tradeoffs, not this implementation's
quality or performance. No third-party implementation was copied.

Verification covers independent scalar source-time/search results and independent
analytic duration/carrier checks at 44.1/48/96 kHz, arbitrary-PCM unity, mismatched
source/output rates, short and zero-padded boundaries, invalid controls/nonfinite
PCM, finite extremes/subnormals, launch/reload/reset/EOF and same-schema exact
snapshot continuation. Packed public import/types, actual native ingress/render,
fixed memory, graph/WASM cost and candidate audio are separate evidence. Every
render is CANDIDATE; no approved golden is replaced. There is no human-listening,
browser/hardware realtime deadline, host integration or full catalog acceptance.

Initial max-size feasibility (65536 frames/H256/S128, local Node 24) measured
296,328 graph bytes, 50,051 WASM bytes, 4,521,984 native bytes and 640 ms compile.
Twenty unloaded quanta observed 43.3 ms cold and 2.42 ms warm maximum. These include
an eagerly evaluated search even though the resident was unloaded; they do not
prove loaded/device performance. The cold quantum greatly exceeds the tested audio
budget, and 2.42 ms already exceeds the 1.33 ms budget at 96 kHz. Later packed diagnostics
must be read alongside this retained observation, not substituted for a guarantee.

Independent review retained a dominant-frequency counterexample: a 997.13 Hz
source at 32000 Hz, output 44100 Hz, L=16384, H128/S128 and D=1.75/P=1.25 produces
an interior Hann-window spectral peak near 1248.1625 Hz instead of the nominal
1246.4125 Hz, a +1.75 Hz deviation. Sparse, integer-offset waveform alignment can
shift the dominant output frequency as well as color its amplitude. The separate
437.3 Hz test's <=0.75 Hz result describes only its measured rate/control matrix;
it is not a universal tuning tolerance. P specifies the exact local grain read
slope, not an artifact-free global spectral-peak guarantee.


Further independent measurements strengthen these limits. The same 997.13 Hz
source/control case at 96000 Hz output has a dominant peak near 1249.4125 Hz,
+3 Hz from the nominal 1246.4125 Hz. The spectral peak is not guaranteed to track
P to a universal tuning tolerance.

For the 48000 Hz, L=8192, period-128 cosine at D=2/P=2 and H256/S64, the intended
750 Hz Hann-window carrier amplitude over output frames [15360,16128) is about
0.00145034, versus about 0.499999997 in the interior. The last nonzero output is
frame 16159 although the active duration ends at 16384. This is padded-edge
cancellation/distortion and loss of intended-carrier energy, not merely a
uniform gain reduction. The earlier late-region peak near 0.309 therefore must
not be read as preserved pitch/tone quality at the edge. No gain compensation
is applied. Exact logical duration and local read slope do not guarantee
transparent duration/pitch output, preserved tail content or completed
catalog time-stretch quality.
