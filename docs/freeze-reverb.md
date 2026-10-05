# Bounded FDN freeze-tail candidate

Status: CANDIDATE / NOT_CLEARED. Native mechanical evidence does not establish
musical approval, browser behavior, or realtime deadline safety.

## Catalog fit and public entry

Original [catalog §10](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3)
separates algorithmic FDN, convolution, and special tails including freeze/shimmer.
This is a bounded special-tail extension: four unequal integer delays with a
Hadamard/2 feedback matrix and an excitation/loss transition into a frozen loop.
It does not finish the whole catalog row or implement shimmer. The existing
`algorithmicReverb` remains its own damped/interpolated candidate.

Import `freezeReverb`, `FreezeReverbConfig`, and `FreezeReverbControls` from
`@denaudio/den/freeze-reverb`. Instantiate with the enclosing `ctx.sampleRate` and
call `tick(left, right, { freeze, reset })` once per audio sample. It returns wet-only
`left`, `right`, `freezeAmount` (f32 [0,1]) and `frozen` (boolean). A consumer owns
its dry/wet blend, bypass behavior, gain staging and any separate tone filters.
No input/output limiter or automatic audio normalization is applied.

## Fixed configuration and bounded capacity

- `sampleRate`: integer 8000..192000, required
- `roomScale`: finite [0.5,2], default 1
- `decaySeconds`: finite [0.1,10], default 1.5; nominal unfrozen loop-loss time
- `transitionSamples`: integer 0..192000, default 256; each direction uses the
  same speed, one integer progress step per processed sample

Out-of-contract configuration throws at graph construction. Rebuild for other
configuration. unworklet eagerly captures at 48 kHz as well as the requested
rate; use `ctx.sampleRate` rather than a captured host rate.

Line lengths are round(sampleRate * roomScale * [0.0297, 0.0371, 0.0411, 0.0437])
integer samples. Each line allocates exactly that many f64 values, one i32 cursor
and one i32 valid count, with one additional shared i32 freeze-progress counter.
Four transient f64 tap slots materialize all reads before any history write.
At 192 kHz / scale 2 the lengths are 11405, 14246, 15782, 16781: 58214 f64 values,
465712 history bytes. There are no dynamically growing buffers or per-sample
allocations. Actual compiled memory includes runtime and port overhead.

There is no predelay, FFT framing, lookahead or host-compensation latency.
The first wet arrival is the shortest fixed network delay; dry is absent. Delay
lengths never move, so freeze transitions introduce no moving-readhead Doppler.

## Excitation, loss and transition contract

Let H be the four-row Hadamard matrix, M=H/2, d_i each delay length and
q_i=10^(-3*d_i/(sampleRate*decaySeconds)). The outgoing delay samples are x_i.
For a freeze amount a in [0,1], the line feedback gains are a+(1-a)*q_i.
The new delay samples are M*diag(gains)*x + (1-a)*B*[left,right], where B contains
the first two orthonormal Hadamard columns. Wet output projects x through the
last two orthonormal rows. The output is read before the current input is stored.

- Live (a=0): excitation is admitted and each traversal loses energy according
  to its fixed q_i. There is no damping lowpass or frequency-selective decay.
- Freezing: progress increments before processing this sample. From live, N true
  samples reach a=1. Input admission falls while feedback gains rise.
- Fully frozen (a=1): excitation is exactly suppressed and every feedback gain
  is 1. Input changes cannot alter the stored tail. Output continues to observe
  the circulating state; reading output does not consume its stored energy.
- Thawing: progress decrements before processing this sample. Loss and excitation
  return over N samples. Reversing direction continues from the current progress;
  it does not restart a full ramp. Held controls settle exactly at their endpoint.
- N=0: immediate endpoints. This and abrupt input/mode changes can click. A ramp
  reduces coefficient jumps but is not a universal click-free guarantee.
- Reset has highest priority: this sample's wet output is zero, input is discarded,
  cursors/valid counts and progress become zero even when freeze is held. Repeated
  reset repeats this behavior. After release, the requested mode ramps from live.

Reset logically invalidates history in constant time; it does not physically
zero every buffer cell. Valid counts prevent stale data from reappearing. An
empty network frozen immediately remains silent. A freeze requested immediately
with a nonzero transition can still admit excitation during that transition.

## Stability, precision and headroom

In real arithmetic, M is orthogonal. With zero excitation, each delay-state update
is nonexpansive for every permitted gain, even during arbitrary mode reversals.
The fully frozen network is lossless in that mathematical model. During sustained
live excitation the fixed q_max<1 supplies a small-gain bound; for finite-energy
input and initially empty state, the wet l2 norm is at most input l2/(1-q_max).
This is conservative, not an output-peak limit or a promise of a particular RT60.
The frozen output can continue indefinitely in the ideal model; there is no finite
frozen-tail cutoff. Use thaw to decay or reset to silence immediately.

Implementation feedback/history use f64 and output uses f32. Rounding makes
perpetual exact energy preservation impossible to promise. Native tests measure
stored-buffer energy drift, rather than treating fluctuating output-window energy
as the stored energy. Very-small-state handling is also finite. Exact power-of-two
internal scaling by 2^256 keeps ordinary and tested tiny f32 signals away from
unworklet's tiny-state scrub threshold; it does not normalize the audio or restore
precision lost in floating-point arithmetic.

Supply finite normalized audio with known headroom. The feedback network can
produce wet peaks above 1; tests retain that behavior. No promise is made for
arbitrary full-scale f32 magnitude, nonfinite inputs, arbitrarily long precision,
or edited/corrupt snapshots. The implementation neither relies on scrubbing for
stability nor presents scrubbed renders as passing evidence.

The integer delays avoid interpolation loss, but a four-line undamped frozen FDN
can sound metallic, sparse, periodic or colored. Orthogonality and numerical
correctness do not establish attractive room/hall/plate sound, pleasant freeze
transitions, echo density, stereo image, or musical usefulness. No physical-room,
commercial-reverb equivalence or high-quality shimmer claim is made.

## Snapshot and verification contract

Use existing unworklet snapshots only. All four delay histories, cursors, valid
counts and ramp progress persist. Transient tap materialization is recomputed each
sample. Same configuration, sample rate and schema restore must continue bit-for-bit,
including snapshots during a transition or fully frozen nonzero history. Cross-rate,
capacity, configuration or schema migration is not provided by this module.

`tests/freeze-reverb.spec.ts` uses an independent absolute-time scalar history
model, with expanded matrix formulas and no circular-buffer or DSL implementation.
At 44.1/48/96 kHz it checks unequal delays and exact impulse arrivals, live/freeze/
thaw and reversals, transition extremes, one/held reset while frozen, excitation
suppression, thaw decay, fresh frozen silence, normalized extremes, tiny excitation,
full-state continuation and measured stored-energy drift. The drift limit is set
at 2e-10 relative over 262144 frozen samples before collecting results. Numerical
oracle tolerances are 3e-7 for normal fixtures and 2e-6 for sustained extreme-input
fixtures. All in-contract native renders require zero scrubs and finite outputs.

`tests/freeze-reverb-packed.test.mjs` packs the actual package, installs it into a
fresh retained consumer, checks the actual public subpath and types, and executes
native WASM with a-rate controls at all three rates against the scalar oracle.
It checks same-schema frozen continuation, fixed memory, all first arrivals at
maximum allocation, and records source/package/WASM/audio hashes. Candidate WAVs
retain raw wet gain. Node process timing is diagnostic only, excludes copies and
is not a browser, hardware, or deadline certificate. Failure logs and consumers
are retained for inspection. No host-render replacement stands in for native DSP.

Implementation is original TypeScript/unworklet composition. No third-party DSP
code or audio assets were copied. The catalog's
[lossless FDN paper](https://arxiv.org/abs/1606.07729) motivates the distinction
between mathematical losslessness and actual reverb quality; it is not validation
of this implementation. Listen to hashed CANDIDATE material before musical approval.

The separate `tests/capture-freeze-browser.test.mjs` requires actual 48 kHz
worklet freeze/thaw, nonzero paired histories, input suppression, divergent live
state followed by native snapshot restoration, and held reset/empty freeze.
These functional browser windows do not measure total stored energy or assert
sample-aligned continuation; the independent offline oracles retain that scope.
The actual browser stage remains an exact-head CI requirement before merge.
