# Delay readhead — GEN-615

`src/delay-readhead.ts` supplies `delayReadhead` and `DelayReadheadConfig`.
It is a mono unworklet subgraph, with no feedback, filter, stereo, mix, or tempo
policy. Instantiate with a required config object and a unique stable name:

```ts
const cell = instantiate(delayReadhead, {
  sampleRate: ctx.sampleRate,
  maxDelaySeconds: 8,
}, { name: 'delayLeft' });
// Once per sample, inside forSample:
const { output, outOfRange } = cell.tick(input, delaySeconds, reset);
```

For same-sample feedback or other processing of the delayed output, use the
read-before-write boundary instead of `tick`:

```ts
const tap = cell.read(delaySeconds, reset);
tap.write(input.add(tap.output.mul(0.5)));
output.write(tap.output);
```

Each sample must use exactly one `read` followed by exactly one call to **that
read's** `write`, or exactly one `tick`; do not combine the two forms on one instance.
`read` captures the current delayed output and reset-adjusted pointers. Its `write`
commits the current input and advances history once. This allows
`writeInput[n] = input[n] + gain * delayedOutput[n]`, with no previous-output bridge
and no extra circulation latency. The returned object and closure exist only while
constructing the unworklet graph, not during audio processing. `tick` delegates to
the same read/write pair. Reset masks old history before the read, then the write
starts new history at the reset sample. The minimal feedback test uses a closed-form
one-sample-delay impulse `[0, 1, 0.5, 0.25, ...]`, including reset and isolation at
all three offline rates; it does not implement the dependent feedback engine.

`input` / `delaySeconds` are `Node<'f32'>`; `reset` and `outOfRange` are
`Node<'bool'>`. Input audio must be finite. The sample rate must be the enclosing
processor's compile-time rate. Use existing AudioParams/events and snapshot APIs;
this module introduces no control, routing, buffer, or persistence framework.

## Capacity and timeline

Construction allocates `ceil(sampleRate * maxDelaySeconds) + 2` f32 samples.
The default is two seconds, configurable at construction, with no resize during
processing. Eight seconds is covered by tests at all three offline rates. Capacity
must include at least one sample and fit signed i32 indexing; allocation is also
subject to the host's memory budget. These are representation constraints, not a
musical/product duration limit. Each instance has independent history and pointers.

At frame `n`, delay `d` in samples produces the linear interpolation of the input
at timeline position `n-d`. Reads precede the write of input `n`; one sample is the
minimum delay, and zero is not a dry feedthrough. For `d=k+f`, the weights are
`(1-f) * x[n-k] + f * x[n-k-1]`. Both adjacent integer indices wrap independently.
No fractional ring-coordinate subtraction is performed in f32: seconds are widened
to f64 before rate conversion, and the fractional weight is finally cast to f32.
This avoids losing small fractional offsets near the end of a long ring.

Finite times saturate to `[1/sampleRate, maxDelaySeconds]`. `outOfRange` reports
requests outside the **f32-representable seconds endpoints**, allowing an AudioParam
set to either endpoint without a spurious warning caused by f32 conversion. NaN
and negative infinity use the minimum; positive infinity uses the maximum, all
with `outOfRange=true`. Saturation ensures safe reads but does **not** establish
correct rhythmic playback. A later tempo consumer must use the flag to reject or
report unavailable times; it must not silently claim that a clamped rhythm is exact.

## Acoustic choice

| Candidate | Time change behavior | Decision |
| --- | --- | --- |
| One continuously moving head, linear interpolation | Read velocity is `1 - delta(delaySamples)`; changing time bends pitch. Abrupt jumps can click or repeat/skip source material. | Selected: one explicit trajectory for modulation and steps, no hidden smoothing or extra transition state. |
| Two stationary heads crossfaded after a change | Avoids the sustained pitch glide but overlaps two different source times; correlated content can comb or cancel. Requires a fade duration and a policy for changes during a fade. | Deferred; does not express the selected moving-head modulation behavior. |
| Higher-order interpolation on a moving head | Retains Doppler behavior with a different high-frequency response; more taps and possible overshoot. | Not needed for this initial bounded two-tap readhead; a future quality change requires new evidence. |

Linear interpolation is not spectrally transparent: for fractional weight `f`,
`H(w)=(1-f)+f*exp(-jw)` apart from integer delay. At half-sample offset its magnitude
is `abs(cos(w/2))`, reaching zero at Nyquist. Nonnegative weights sum to one, so it
cannot overshoot the extrema of its two finite inputs. Arbitrary fast modulation
can alias; no anti-aliasing or click-free transition guarantee is made. Abrupt
controls take effect at their sample with no smoothing. A delay slope of +1 holds
the source position, and -1 doubles its traversal rate; analytic tests verify both.
Human sound evaluation remains a later batched instrument/FX step.

## Reset and state

Reset applies before the read at the dispatched sample. It resets the logical
write pointer and valid-history count, producing zero immediately. The current
input is then written as the first sample of the new history. Held reset keeps
output silent. There is no pre-reset contribution to either fractional tap.

This is a constant-time **logical history clear**, not a physical memory wipe.
Pinned unworklet 0.4.1 has no buffer-clear DSL operation. Old storage bytes can
remain in a snapshot until overwritten but are unreadable by this readhead; this
is not a data-erasure API. Reset may click. `history` (persistent f32 buffer),
`cursor` (i32), and `valid` (i32) use unworklet state with stable instance prefixes.
Snapshot continuation is supported only with the same schema, capacity, and rate.
The tests restore history, compare continuation, and prove reset cannot resurrect it.

## Evidence and integration

`tests/delay-readhead.spec.ts` uses an unbounded input-timeline reference, independent
of ring storage, and analytic impulse/pitch expectations. Tests cover minimum and
maximum, fractional wrap, steps, modulation, invalid controls, state isolation,
reset across block/wrap boundaries, and same-schema continuation. Sample comparisons
use absolute tolerance 2e-6 (4e-6 for analytic pitch tests); scrubbing must remain zero.
The fixture rejects an intentionally wrong waveform. No audio golden is used.

`tests/delay-packed.test.mjs` packs the package, installs it into an isolated locked
consumer, checks declarations strictly, renders offline at 44100/48000/96000, and
builds and renders Chromium at **48000 only**. It uses the physical installed
`dist/delay-readhead.js` entry while public exports await integration. It neither
imports repository source nor edits an installed dependency. The existing entry
test retains the other-rate browser rejection probes.

Artifacts in `artifacts/delay/` are CANDIDATE: raw WAVs, static waveforms, the packed
tarball/consumer lock, browser samples, and a manifest linking source/settings/input
and file hashes. CI uploads these through the existing artifact step.

Minimal proposed integration patch (not applied in this lane):

- `src/index.ts`: `export { delayReadhead, type DelayReadheadConfig } from './delay-readhead.js';`
- Optionally expose `./delay-readhead` with types `./dist/delay-readhead.d.ts` and
  import `./dist/delay-readhead.js` in `package.json`.
- Once approved, replace the packed fixture's physical import with the chosen
  public import; package/lock, shared consumer, and shared contract edits remain
  owned by integration.
