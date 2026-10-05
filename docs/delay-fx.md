# Stereo delay FX — GEN-618 / GEN-620

One `delayFx` unworklet subgraph composes the existing readhead, low-pass and LFO.
It has no loader, parameter registry, state codec, routing framework, extra effect
engine or FFT. Call `tick(left, right, controls)` once per sample. Audio and numeric
controls are finite f32 nodes; sync/bypass/reset are boolean nodes. Duplicate mono
input explicitly. State is independent per engine/channel; there is no crossfeed.

Configuration is immutable: `sampleRate` (integer 8000–192000, from processor ctx),
`maxDelaySeconds` (default 8), `tone` (`lowpass`, default, or `flat`) and
`stereoPhaseCycles` (default 0.5, wrapped modulo one). Eight seconds is a provisional
construction default covering a whole note at 30 BPM, not a product ceiling.
Allocation is two readhead buffers of `ceil(rate * capacity) + 2` f32 samples, plus
scalar filter/LFO/control state. At 96 kHz the default buffer storage is 6,144,016
bytes; callers own the memory budget. No audio-thread resize occurs.

## Controls and sound

| Control | Unit / policy |
| --- | --- |
| timeLeftSeconds / timeRightSeconds | Independent base delays when sync is false; minimum one sample, maximum construction capacity. |
| sync, bpm, beatsLeft / beatsRight | Sync uses `60 * beats / bpm`; one beat is a quarter note. BPM domain 30–300; positive fractional beats express subdivisions, triplets and dotted values. No independent beat-count product ceiling; actual time must fit capacity. |
| feedback | Linear multiplier, clamped to [0,0.95]. Positive repeats only. |
| cutoffHz | Feedback tone cutoff clamped to [20,min(20000,0.24*rate)]; Q is fixed at 0.5. Flat mode bypasses tone in the feedback path. |
| mix | Linear dry/wet crossfade, clamped to [0,1]. No equal-power boost, limiter or normalization. |
| rateHz / depthSeconds | Shared LFO module, rate clamped to [0,20], depth [0,0.05]. Left reset phase 0, right reset phase stereoPhaseCycles. Both initialized on the first tick. |
| bypass | Unity dry, stop feeding new input, keep the internal feedback/tone/LFO running. Unbypass may reveal remaining tail. |
| reset | Clear logical delay history/pointers, filter history and LFO phases at this sample; new input at this sample begins new history. Dry contribution remains audible. Held reset silences wet. |

A read happens before the current input write. Per channel,
`wet[n] = delayRead(history, time[n])` and
`write[n] = admittedInput[n] + feedback[n] * tone(wet[n])`.
There is no additional sample in the feedback loop. The first repeat is unfiltered;
the tone shapes each subsequent circulation. Input stop (zeros) preserves decay.
Bypass and rejected timing admit zero new input. Reset is independent of bypass.

Time, tempo and stereo-tap edits move the existing readheads immediately. There
is no crossfade or smoothing: abrupt changes can click, skip/repeat source samples,
and cause Doppler pitch motion. LFO modulation uses the same moving-head behavior;
right phase 0.5 gives opposite motion, while phase 0 and equal taps preserve dual
mono. Dry/wet or bypass steps can also click. These discontinuities are explicit
policies, not a claim of sound approval. No arbitrary audio-rate modulation
anti-alias guarantee is made. GEN-621's two musical settings remain separate.

## Capacity rejection and clipping

Both requested base times must fit the f32-representable bounds. In sync mode BPM
must also be in range. A bad stereo request (including a too-short/nonpositive
base time) sets `timingRejected=true`, emits unity dry on both channels and admits
zero new input. Internally, both previous accepted base times are retained so the
old tail continues. On reset, rejected times fall back to one sample with cleared
history. A later valid request is accepted immediately with the same moving-head
transition policy. There is no silently clamped rhythmic playback.

LFO depth is applied after an accepted base time. Final modulation saturates at
the buffer bounds and sets `modulationClipped=true` when clipping occurs. This
flag is separate from invalid base timing. Consumers should display rejection
and clipping using existing unworklet events/state if desired; no new transport
is supplied here. Runtime sample-rate-specific compilation is unchanged: browser
acceptance is 48 kHz only; 44.1/48/96 kHz offline coverage is separate.

## Feedback bound, including cutoff modulation

A fixed-frequency low-pass magnitude bound alone does not prove a time-varying
loop stable. For the shared SVF with Q=0.5, let `g=tan(pi*cutoff/rate)`, and express
its stored state in coordinates `p=band+low`, `q=low`. The same equations are:

```
u = (p + g*x)/(1+g)
y = (q + g*u)/(1+g)
pNext = r*p + (1-r)*x
qNext = r*q + (1-r)*u
r = (1-g)/(1+g)
```

For `0<g<1`, every expression is a convex combination. The chosen 0.24*rate cap
keeps g below one with margin for the shared coefficient approximation. This
property holds under sample-by-sample cutoff changes, unlike a stationary-only
frequency response argument. Linear readhead interpolation is also convex, and
independent stereo channels do not add energy to each other. If input magnitude
is at most A and history starts clear, the common amplitude invariant is
`A/(1-0.95) = 20*A` for delay storage, tone coordinates and wet output, apart from
floating-point rounding. Thus arbitrary admitted time/cutoff modulation cannot
create unbounded self-oscillation under these control bounds. Feedback <1, finite
capacity and strictly positive bounded cutoff also give eventual decay after
input stops; the tests include the slowest-cutoff/highest-gain tail. There is no
threshold tail kill added by den; pinned unworklet flushes tiny values (<1e-30).
Flat tone has the same loop bound without the filter stage. At DC, unity input
can accumulate to 20; users must gain-stage the output. No hidden compensation
conceals this behavior.

## State and composition cost

Readhead history remains a logical reset, not a physical memory wipe. Persistent
slots are inherited readhead/filter/LFO state plus `first`, `acceptedLeft` and
`acceptedRight`. Restore is supported only for the same schema, configuration and
rate, using unworklet's existing snapshot path after parameters have rendered.

Seven transient f32 scalar slots and one transient boolean materialize LFO
outputs, final times, wet reads, cutoff and timing validity within each sample.
The accepted-time state is read after its current-sample write, avoiding repeated
expansion of the same selection. They are overwritten before use and add no sample latency.
They prevent recursive expansion of the composite expression graph in pinned
unworklet 0.4.1; no compiler/runtime replacement or upstream edit is introduced.

## Evidence

`tests/delay-fx.spec.ts` compares against an unbounded written-input timeline,
independent direct-form bilinear biquad and (for time-varying cutoff) two one-pole
cascade coordinates. It does not copy the circular storage or SVF recurrence.
It checks repeat positions/amplitudes, fractional taps, gain bounds, filtering,
bypass/reset/restart, stereo/mono/mix endpoints, tempo acceptance/rejection,
modulation clipping, discontinuity policy and same-schema continuation at all
three rates. Ordinary references allow 3e-6 absolute error, chorus/variable tone
4e-6. Wrong waveforms fail. Extreme LFO-depth/cutoff modulation additionally checks
the derived common amplitude invariant, separately from sample comparisons to
avoid treating tiny sine-polynomial errors amplified by seconds-to-samples
conversion as filter recurrence errors. Each long-tail test runs 2^20 samples
(10.9–23.8 seconds depending on rate), with bounded peak and final tail <1e-6.

`tests/delay-fx-packed.test.mjs` installs the actual tarball into an isolated locked
consumer, strictly checks declarations, compares rendered feedback/tone against
a separate direct-form reference, builds the standard unworklet browser path and
exercises mix/bypass/reset/capacity rejection and snapshot restore at 48 kHz.

The sustained browser gate records 2^19 frames (10.92 seconds) downstream of the
worklet: actual input plus left/right output, with four seconds of sustained
220-Hz input and more than six seconds of tail. `capture.ts` is a fixed test fixture
built with existing unworklet buffers, audio ports and snapshots. It writes three
channels on the audio thread, emits silence, and reads its snapshot after suspend.
A guard quantum protects the requested prefix after recording fills. The frame
counter must cover the entire requested prefix. No custom loader, transport or
capture framework is added; the product processor is unchanged.

Every captured output sample is compared to an independent reference driven by
captured input at the unchanged 6e-6 threshold. Input continuity retains its 1e-6
sine-recurrence threshold and exact four-second span. A ten-second native source
control always runs, including its full sustained span; all three captured control
channels must be identical. There are no passing-retry selection or skipped
startup samples. Raw PCM and source/hash manifests are retained. This verifies
graph-sample continuity, not hardware-output delivery or scheduler deadlines.

The original ScriptProcessor apparatus produced false discontinuities. In one
simultaneous recording, internal input was continuous and internal outputs matched
the independent reference (left 7.45e-9, right 0), while external capture first
diverged at sample 73728 and lost 640 source samples. A separate internal-only run
had the same reference accuracy. Another saved tail failure started exactly at
capture block 393216: shifting the reference by 128 samples restored right-channel
bit equality and left error below 5.83e-11. The source was already silent, so a
short native-source control could not diagnose that tail capture loss. This is
why the baseline now sustains for ten seconds. See `delay-fx-capture-findings.json`
for numerical results and hashes; raw evidence and diagnostic fixtures are kept
in `artifacts/delay-fx/capture-investigation/`. The original failures are preserved,
not converted into passing comparisons by alignment or tolerance changes.

Deadline safety remains a separate unresolved question. Real AudioWorklet traces
have included startup and non-startup CPU/wall-time budget exceedances even after
expression materialization; replacing the recorder does not clear those findings.
No listening approval is inferred from corrected waveform capture.

`performance.mjs` separately measures the existing driver with byte-identical
packed browser WASM. It records size/hash, controls, warm-up, mean/p99/max block
time and total wall time for 12 seconds of audio. This host-dependent direct-WASM
diagnostic excludes browser scheduling/copy overhead and does not replace the
real-time gate. After the composition audit, WASM decreased from 62,653 to 45,935 bytes. Local
direct-driver mean decreased from 0.366 to 0.071 ms per 128 frames. The latter run
still had a 4.677 ms maximum versus a 2.667 ms budget; average cost alone does not
establish real-time readiness. Against commit 6cf15d1, all four output/status
channels were bit-identical over 18 cases: 44.1/48/96 kHz, flat/lowpass, and LFO
rate/depth pairs 0/0, 4 Hz/2 ms, 12 Hz/20 ms. Each case rendered 16384 samples with
sample-varying time, cutoff, gain, mix, sync, bypass and reset. This equivalence
check supplements the independent numerical references; it is not a golden. That
composition audit changed no shared module or unworklet source; no general
real-time performance guarantee is made.

The subsequent main integration includes the filter materialization described in
`filter-materialization.md`. It preserves the persistent schema and tiny-value
behavior while reducing this consumer's WASM to 24,707 bytes (SHA-256
`74ab305c15c932d3d7bc32e7d4a0499439adfdfb107355f329e46d1ffea9fdb0`).
The prior 18-case comparison against the 7ef7ce6 delay engine also found identical
complete snapshot bytes, and bidirectional restored continuation matched continuous
rendering with an ignored-restore negative control. The delay engine, readhead and
LFO sources are unchanged by this main integration.

The exact same generated WASM is covered by the recorded four cold candidate
trials in `filter-materialization-results.json` (first callback wall time
1.659–1.900 ms). Reusing matching source/WASM hashes avoids another timing sample;
these local measurements are not universal deadline clearance or evidence of a
hot-loop speedup. Non-first callback outliers, native-control observations and
clock anomalies remain separate limitations. The full numerical/packed suite also
checks the shared audition consumer introduced on main.

`artifacts/delay-fx/` contains CANDIDATE WAVs/raw browser PCM, static plots and a
manifest linking source hashes, exact settings/input, rates, dependency locks,
package tarball and verification results. No golden is approved or updated.

## Public integration

`@denaudio/den/delay-fx` exports `delayFx`, `DelayFxConfig` and `DelayFxControls`.
The isolated consumer imports that public subpath. The engine fixture remains
separate from the Chorus/Rhythmic setting fixtures and the complete integrated
site. Shared exports/package/lock/contracts and the UI retain one integration owner.
