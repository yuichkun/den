# Rolling live sample buffer candidate

Status: **CANDIDATE / NOT_CLEARED**. Catalog §3 calls out fixed-capacity live
history, its age and read/write competition. This module provides that native
storage/read contract. It adds no microphone/device capture, host transport,
streaming, overdub, sample loader, grain scheduler, normalization or limiter.
Audio and builds produced by its tests are not listening-approved goldens.

## Entry and coordinates

Import `liveSampleBuffer`, `LiveSampleBufferConfig`, `LiveSampleBufferControls`,
`LiveSampleBufferRead`, `LiveSampleBufferStatus` and `LiveSampleBuffer` from
`@denaudio/den/live-buffer`. Instantiate once in a native processor:

```ts
const history = instantiate(liveSampleBuffer,
  { capacity: 65536, sampleRate: ctx.sampleRate }, { name: 'history' });
// Within forSample, choose the order deliberately:
const previous = history.readAge(f64(0));
const status = history.tick({ input, record, reset });
const current = history.readAge(f64(0));
```

Capacity is an immutable integer in 1–65,536 mono frames. `sampleRate` is the
incoming processor rate in [8,000,192,000] Hz, without resampling. At capacity
65,536, continuous recording retains approximately 1.486 s at 44.1 kHz, 1.365 s
at 48 kHz or 0.683 s at 96 kHz. Rate conversion, stereo pairing and routing are
the caller's composition. There is no automatic input-monitor output.

`readAge(ageFrames: Node<'f64'>)` returns `{output,available}`. Ages count
**accepted writes**, not elapsed processor frames or wall-clock time:

- Age 0 is the newest accepted write at this call's statement position; age 1
  is the write immediately before it. Fractional age interpolates toward older
  writes. For history [10,20,30] in chronological order, age .25 returns 27.5.
- A finite age in inclusive [0,length−1] is available. At an integer age, the
  exact recorded frame is returned. At the oldest valid integer, the older tap
  is held at that frame. Capacity one therefore supports only age 0.
- Negative ages, NaN, infinities, unfilled ages and ages beyond retained history
  return zero with `available:false`. No endpoint clamping, zero-padded blend,
  extrapolation or wrap from oldest to newest is applied to unavailable ages.
- The circular storage address wraps, but the age coordinate does not. An age
  just above length−1 is unavailable even if stale bytes exist at that address.
  Fractional reads never interpolate into overwritten or unfilled history.
- Pausing freezes all ages and bytes. It does not insert silent frames. A fixed
  age is a moving delay tap while recording, then a frozen sample while paused.
  After another write, a surviving sample's age increases by one; at capacity,
  the former oldest sample expires.

This interface intentionally is **not `ResidentSample`**. It has no `load`,
chronological `read`, or `sourceSampleRate` member, and must not be passed to
existing `samplePlayer`, `multisamplePlayer` or `granularSource` through a type
cast. Those readers interpret stable asset positions; rotating chronological
indexes would silently change an active grain's meaning. Stable captured takes
remain the separate `residentTakeRecorder` contract. The separate
[`liveGranularSource`](live-granular.md) reader explicitly tracks accepted-write
motion and expiry, with writer-before-reader order and a shared reset.

## Writer, ordering and revision

Call `tick({input,record,reset})` exactly once per incoming sample:

- Initially length, head and revision are zero; every read is unavailable.
- When record is true and reset false, accept one input frame. Before capacity,
  length grows by one. At capacity, length stays fixed and the oldest frame is
  overwritten. A false record pauses without modifying exposed history.
- Reset is level-sensitive and wins over record. It sets head and length to
  zero and accepts no input. A held reset stays empty. Still-high record resumes
  on the first non-reset tick, beginning a new history at frame zero.
- The returned `{written,full,length}` describes the operation's result.
  `written` includes accepting zero or sanitizing invalid input to zero; `full`
  becomes true on the write that first fills capacity and remains true through
  later overwrites or pauses until reset.
- Native statement order is the visibility boundary. A read before `tick` sees
  the previous history, including before reset; a read afterward sees the
  complete write or empty reset. PCM is written before head and length advance.
  Calling several readers between writes is supported. This is not a concurrent
  host writer or cross-thread consistency contract.
- `length()` returns the current retained count. `revision()` is a wrapping i32
  mutation serial incremented once for each accepted write or reset tick.
  Pause leaves it unchanged. Reset+record increments once, not twice. Compare
  revisions for equality/inequality, never numeric ordering; 2^32 mutations can
  revisit the same value. Revision is neither an absolute timestamp nor a stable
  frame identity, and no compatibility with resident asset revisions is implied.

Read-before-write age 0 is the last accepted frame, not the current input.
Read-after-write age 0 is current input when accepted, including at ring wrap.
This order matters for zero-delay and feedback composition. No implicit delay,
feedback loop, read/write safety margin or click-free transition is supplied.

## Amplitude, storage and snapshots

All finite f32 input is supported, including values beyond ±1, full f32 extrema
and subnormals. NaN and ±Infinity are recorded as zero, without depending on the
output scrubber. Input signed zero records as positive zero. Linear reads use
f64 intermediate arithmetic, so opposite full-range taps do not overflow their
difference. Interpolation is not anti-alias filtering; rapid age changes can
click or alias, and downstream gain or feedback can overflow independently.

Core 0.4.1 scalar stores flush magnitudes below 1e-30. The native persistent
buffer therefore stores `f64(input) * 2^128`, decoding by the same exact binary
factor. This is a storage encoding, not signal gain or normalization. Every
finite nonzero f32 is above the store floor and far below f64 overflow when
encoded. The transient age cache is likewise scaled by 2^192 to retain tiny
fractions that can make a representable f32 difference against full-range PCM.

Storage is one fixed C+1 f64 buffer: exactly `8*(C+1)` bytes, or 524,296 bytes at
capacity 65,536, plus three persistent i32 states (head/length/revision), a
transient f64 read cache and normal runtime/IO overhead. The extra cell is an
unreachable sentinel. Paused/reset ticks write zero only there because native
`select` evaluates both branches. Processing allocates no growing history or
new per-sample buffers; writes and each read use fixed bounded work.

Reset is **logical invalidation, not secure erasure**. Old history remains in
snapshot bytes until overwritten but cannot be read through `readAge`. Snapshot
state includes the buffer, head, length and revision; the read cache is excluded.
Exact continuation applies only to the same graph, configuration and sample
rate with the same subsequent input/control sequence. No new serializer or
cross-configuration migration is provided. Core 0.4.1 live state restore and
host AudioParam restore are not atomic; this module does not fix that boundary.
Establish safe host controls before restoring a live writing graph. Offline
continuation evidence is distinct from an arbitrary live-control restore claim.

## Verification and limits

`tests/live-buffer.spec.ts` compares all pre/post-read, availability and writer
status samples to an independent chronological-array reference at 44.1/48/96
kHz. It covers capacity one/two/17, every physical wrap position, fractional ages
adjacent to newest/oldest retained samples, invalid/unfilled/expired reads,
pause, held reset, tiny/full-range PCM, tiny f64 ages, revision wrap, snapshots
while partial/full/paused/reset, stale-byte exclusion, and maximum fixed storage.
The reference does not use a circular buffer or production addressing helpers.

`tests/live-buffer-packed.test.mjs` installs the actual tarball into a locked
isolated consumer, checks the public types, renders all-sample references and
same-schema continuation at three rates, then builds actual Vite worklet/WASM
assets. Its 65,536-frame memory diagnostic actively records through two wraps,
checks the oldest-age output and confirms constant native memory. Source,
tarball, lock, audio and build hashes are retained with failure phases.

These are bounded offline/build checks, not browser execution, device capture,
real-time deadline or listening approval. There is no streaming, long-form
recording, live granular playback, overdub or fixed-latency host integration
claim. Audio candidates preserve raw gain; no normalization or limiter masks
their output.

## Small actual-browser composition

The separate `tests/live-buffer-browser.test.mjs` requires an actual 48 kHz
worklet. A native fixture counter gates exactly 3, then 20, accepted writes into
capacity 8, independently of host timer delays. This counter is test composition,
not a capacity stop in the rolling-buffer API. An exact binary ramp exposes both
wraps, every retained sample, fractional/expired reads, pause and reset/resume.
Native accumulated pre/post-read sums verify statement order during the brief
writing intervals rather than inspecting only a later silent/paused window.

For in-place state restoration, the fixture saves a full wrapped positive
history and replaces it with a short negative one. It first renders recording
off, then renders all saved controls and proves the negative mutation remains.
Restore must recover the original PCM, length, cursor-dependent continuation,
revision and accumulated sums; every retained age is read back. No microphone,
host transport, arbitrary live-control atomicity or hardware continuity claim
is involved. Three-rate native chronological references precede browser execution.
