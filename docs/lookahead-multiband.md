# Lookahead limiter and three-band dynamics candidates

Status: **CANDIDATE**. These additive modules extend catalog section 9 with a
bounded sample-peak lookahead limiter and a phase-compensated three-band
composition. They reuse unworklet 0.4.1 and the existing reviewed peak follower,
LR4 crossover and dynamics. Generated audio is not a golden or human-approved
sound. Offline correctness is not browser or hardware real-time clearance.

## Measured real-time boundary

The first clean packed proof (`a2f2b0e`, 2026-10-05) measured the full
17-output three-band fixture at 44.1/48/96 kHz. It exceeded the local 128-frame
quantum budget in **28/512, 66/512 and 221/512 blocks**, respectively. P99 times
were 4.59/5.01/4.40 ms. At 96 kHz its median was 1.277 ms against a 1.333 ms
quantum. **This multiband graph is not real-time cleared.** The maximum-2048-sample
limiter had no budget exceedances in the same local diagnostic, which also does
not establish browser or device clearance.

These are local Node-driver wall times after 128 warm-up blocks, repeating the
first 128-frame input/control block, excluding audio I/O copies and browser
scheduling. They are useful negative evidence, not a universal capacity limit or
an acceptance benchmark. Stage materialization reduced the separate mixed-mode
comparison fixture from 6,752,682 to 153,584 WASM bytes while preserving all
17 output channels byte-for-byte at three rates. That compile-size improvement
does not remove the measured runtime boundary.

## Entry contracts

- `@denaudio/den/lookahead-limiter`: `lookaheadLimiter`,
  `LookaheadLimiterConfig`, `LookaheadLimiterControls`.
- `@denaudio/den/multiband-dynamics`: `multibandDynamics`,
  `MultibandDynamicsConfig`, `MultibandDynamicsControls`,
  `MultibandDynamicsBandConfig`, `MultibandDynamicsBandControls`.

Instantiate with stable unique names and call each instance exactly once per
sample. `sampleRate` is an integer from 8000 through 192000 Hz and must equal the
enclosing processor's compile rate. All runtime numeric inputs are native f32
Nodes and reset is a native boolean Node. There is no alternate runtime,
parameter, snapshot or routing framework. State restoration requires the same
schema, construction configuration and rate.

## Limiter: exact window and fixed latency

Configuration is `{sampleRate, lookaheadSamples}`. The delay is a required integer
in **0..2048**; it cannot be changed at runtime. Latency is exactly that many
samples, exposed as construction-time `latencySamples` and `latencySeconds`.
The capacity is a resource boundary, not a claim that every setting is real-time
safe. At 44.1/48/96 kHz, the maximum is about 46.44/42.67/21.33 milliseconds.

`tick(left, right, {ceilingDb, release, reset})` returns limited `left`/`right`,
latency-matched `dryLeft`/`dryRight`, and `windowPeak`, `envelope`, `gain` and
`ceiling` diagnostics. There is no implicit makeup, mix or bypass. Dry mixing or
another processor after the limiter can violate the ceiling.

Let N be the delay and p[n] be the larger absolute current L/R input. On sample n,
the detector target is the **inclusive maximum of p[n-N] through p[n]**, bounded
by the latest reset. The output program sample is input[n-N]. Processing order:

1. If reset, invalidate all preceding audio and detector history.
2. Insert current L/R and their peak in the ring and max tree.
3. Recompute the tree path and obtain the inclusive window maximum.
4. Update the existing peak follower with zero attack and requested release.
5. Apply the current ceiling/envelope ratio to the N-sample-old program.
6. Advance the ring cursor.

Attack is immediate. Lookahead conservatively attenuates audio up to N samples
before a transient emerges; it does not interpolate a gain ramp. The follower
release is the reviewed one-pole amplitude detector recurrence, not linear-gain
or dB-gain release: `c=1-exp(-1/max(1,release*sampleRate))` for positive release,
otherwise c=1. The envelope never falls below the current window maximum.
Release is clamped to 0..30 seconds, with nonfinite values falling back to zero.
Abrupt ceiling/release edits can cause discontinuities and pumping is possible.

`ceilingDb` is clamped to -120..0 dBFS, with nonfinite values falling back to zero.
Its f32 exponential amplitude is returned as `ceiling`. The exact discrete
contract is `abs(output[channel][n]) <= ceiling[n]`, not an infinite-precision dB
identity. A downward ceiling edit constrains **the output sample at that moment**,
including previously buffered audio; ceilings are not delayed with the program.
The gain is `min(1,ceiling/envelope)`, or one for a zero envelope. Multiplication
stays binary64 until final output conversion, so maximum finite f32 audio at a
-120 dB ceiling is not multiplied by a quantized subnormal f32 gain. Returned
`gain` is a rounded f32 diagnostic; it may underflow or have poor relative
precision at extreme inputs and must not substitute for the actual audio path.
The final output clamp guards floating-point ceiling rounding.

All finite f32 program inputs, including subnormals and above-full-scale values,
are preserved on the dry path. As in native unworklet state, negative zero is
normalized to positive zero. Nonfinite program samples become zero. This
limiter measures samples, not intersample reconstruction peaks. It performs no
oversampling, true-peak estimation or certification.

### Reset and memory

Reset invalidates history before the current input. An N>0 limiter then emits N
silent samples while filling; N=0 processes the current sample immediately with
fresh detector history. Holding reset high thus keeps N>0 output silent, whereas
N=0 continues limiting each current sample independently. Reset is not a
click-free bypass operation. Dry and wet always share the same delay/reset rule.

There are N+1 stereo ring positions and a power-of-two max tree. Every sample
updates only one leaf and `ceil(log2(N+1))` ancestors. No data-dependent search,
allocation, epoch counter or reset-time full-buffer scan occurs. At maximum N,
three binary64 buffers occupy 98,320 bytes plus a fixed small scalar history.
All audio/peak buffer values use exact power-of-two scaling, preserving f32
subnormals through unworklet's less-than-1e-30 state-write flush.

The reset-validity invariant is an initially empty prefix of leaves. During
sequential refill, an included sibling subtree starts before the valid-prefix
end and has already been rebuilt since reset; a sibling starting at or beyond
that end is read as zero. The prefix expands by one leaf per sample. After full
refill, all real leaves remain valid through wraps, while padding leaves are
always excluded. This also holds at N=0, non-power-of-two window lengths,
first wrap, repeated resets and repeated wraps. No stale pre-reset peak can
reappear. Rings, tree, cursor, prefix count and follower state are persistent in
native snapshots.

## Three-band phase-compensated dynamics

Configuration is `{sampleRate, bands:[lowConfig,midConfig,highConfig]}`. Each band
configuration has the existing `DynamicsConfig` mode, operation and optional
hysteresis, excluding sampleRate. Controls are `{lowCutoffHz,highCutoffHz,bands,
reset}`; each of the three control records is `DynamicsControls` without reset.
Each band uses its own filtered L/R program as a max-absolute linked stereo
sidechain. There is no external sidechain or lookahead in this composition.

Finite audio is passed without input clipping; nonfinite samples become zero.
The **caller headroom precondition for the tested boundary is |L|,|R| <=16**.
This is not an arbitrary-full-f32-input guarantee. Recombination and transients
can exceed input or full-scale peaks even when all dynamics gains are at most
one. This processor has no output ceiling. Apply the separate limiter afterward
if a discrete sample ceiling is needed.

Cutoffs use finite fallbacks of 200 and 2000 Hz respectively, clamp individually
to `[20,min(20000,0.45*sampleRate)]`, then sort ascending. Reversed controls are
therefore equivalent to sorted controls. Equal cutoffs are permitted; the middle
branch does not vanish merely because the cutoffs coincide. Each edit takes
effect on the current sample without clearing filter or dynamics history.

At fixed cutoffs, writing Lf/Hf for the existing LR4 low/high transfers and
Af=Lf+Hf for their positive-polarity allpass sum, the bands are:

- Low: `Llow * Ahigh` (the extra high-crossover sum compensates its phase).
- Middle: `Hlow * Lhigh`.
- High: `Hlow * Hhigh`.

At unity dynamics gains, the complete transfer is **Alow * Ahigh**, of unit
magnitude with frequency-dependent phase. The low-band compensation is essential;
naively splitting only the high branch a second time does not reconstruct this
transfer. No explicit integer sample delay is added, but IIR phase/group delay
is frequency dependent. This is not identity PCM or a linear-phase crossover.
Static transfer guarantees do not imply flat magnitude under moving cutoffs.

The results contain `left`, `right`, phase-matched `dryLeft`/`dryRight`, three
existing dynamics result records `low`/`mid`/`high`, and effective sorted cutoff
Nodes. The dry outputs are the unprocessed **allpass recombination**, not original
PCM. Dry/wet mixing can use this phase-matched reference, but dynamically unequal
band gains still change phase and magnitude. No implicit output normalization is
performed. All six crossover instances and three dynamics instances reset before
the current sample; their native state is independent and snapshot-persistent. Two fixed five-element
scaled binary64 scratch buffers materialize existing f32 crossover stage
boundaries once instead of re-expanding them at each consumer. They add 80 bytes
and are transient: every element is overwritten before use on each sample, so
they need no saved history. Exact scaling preserves nonzero f32 values and the
original stage rounding; native signed-zero normalization still applies.

## Verification scope

The focused tests use an independent naive timeline maximum for the limiter,
independent exponential recurrence for its detector, RBJ direct-form-I filter
references for static bands, and complex transfer products for recombination,
including DC. They cover 44.1/48/96 kHz, capacity endpoints, first-fill and repeated
wraps, reset and held reset, current-output ceiling automation, malformed inputs,
full-range and subnormal limiter audio, per-band gain controls, cutoff sorting
and equality, same-schema snapshot continuation, finite caller headroom and zero
scrub diagnostics. A maximum-capacity compile/memory check is bounded evidence,
not a deadline assertion.

The isolated consumer installs the actual packed public exports, strict-checks
TypeScript and renders the same candidate surface with independent numerical
assertions. Its manifests record exact source/package hashes, rates, controls,
raw candidate audio and native diagnostics. Browser, external-device and
maximum-capacity real-time support are not established by offline evidence.
Independent review and exact-head aggregate CI remain required before merge.
