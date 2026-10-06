# Live history granular reader candidate

Status: **CANDIDATE / NOT_CLEARED**. This bounded catalog §3 reader consumes the
native rolling history from `@denaudio/den/live-buffer`. It supplies a fixed grain
pool and windows, without an input device, loader, density scheduler, random
jitter, host transport or streaming contract. Existing resident sample readers
remain separate; do not cast rolling history to `ResidentSample`.

## Public composition and statement order

Import `liveGranularSource`, `LiveGranularConfig`, `LiveGranularControls`,
`LiveGranularResult` and `LiveGranularSource` from `@denaudio/den/live-granular`.
Construction accepts `{history: LiveSampleBuffer, maxGrains: number}`. `maxGrains`
is an integer in 1–8; the history has fixed capacity 1–65,536 and a finite processor
sample rate in [8,000,192,000] Hz. The reader adds no PCM buffer. Instantiate once:

```ts
const history = instantiate(liveSampleBuffer,
  { capacity: 65536, sampleRate: ctx.sampleRate }, { name: 'history' });
const grains = instantiate(liveGranularSource,
  { history, maxGrains: 8 }, { name: 'grains' });
// Within every stride-1 forSample iteration:
const status = history.tick({ input, record, reset });
const result = grains.tick({
  written: status.written, reset, trigger,
  ageFrames, rate, durationSeconds,
});
output.write(result.output);
```

Call the writer exactly once, then each reader exactly once per sample. Pass the
writer's actual `status.written` and the **same reset signal**. Several readers can
share that result; no intervening write/reset is allowed. `record` is not a
substitute for `written`: reset suppresses a write, while an accepted invalid
input still writes sanitized zero. The history sample rate must match the
processor. No source-rate conversion is performed. Skipping calls, mismatching
reset, or supplying a fabricated write status is unsupported.

## Launch controls and pool policy

`trigger` is level sensitive: each true non-reset sample requests one new grain.
A held trigger requests every sample. No gate, automatic onset, density clock or
queue is implied. The following f32 controls are latched only on successful launch:

- `ageFrames`: finite accepted-write age in [0,capacity−1], also currently within
  [0,history.length()−1]. Zero means the newest frame after this sample's write.
- `rate`: finite signed history frames per output sample in [−16,16]. Positive
  moves toward newer source material; negative moves toward older material.
- `durationSeconds`: finite [0,2]. Duration is
  `clamp(floor(durationSeconds * history.sampleRate + .5),3,round(2*sampleRate))`
  output samples. Zero is valid and produces a three-frame grain; negative,
  NaN and infinite values are rejected.

Invalid controls or an unavailable onset set `rejected:true`. They do not clamp
to a source endpoint, steal a slot, or alter current grains. Internal eager
branches use safe operands before integer conversion, including on rejected
NaN/infinite requests. Valid requests use the first free slot in stable index
order. A full pool sets `dropped:true`; no stealing, restart or delayed retry
occurs. `launched` means allocation succeeded. `dropped` and `rejected` are mutually
exclusive; all three are false without a request or during reset.

An existing unavailable grain is terminated before allocation, so its slot is
available for a new grain on that same sample. Changing age/rate/duration while a
grain runs only affects later requests. There is no implicit output gain control.

## Accepted writes, movement and expiry

Let `a[n]` be a grain's read age at processor sample n. At launch it is exactly
`ageFrames`, measured **after the current write**, without adding that write again.
For a surviving grain on the next sample:

```
a[n+1] = a[n] + ((written[n+1] ? 1 : 0) - latchedRate)
```

The increment is formed before addition. Continuous writing at rate 1 therefore
preserves even a tiny representable onset fraction; computing `(tinyAge+1)-1`
would lose it. At rate 0, the grain stays at the same source identity, whose age
increases with accepted writes until overwritten. Under continuous writing, rate
1 holds a fixed delay age. Pausing freezes history, **not** the grain clock or
source movement: a positive-rate grain moves toward the newest retained edge and
may expire. Resuming recording cannot revive a terminated grain.

Every read must be in the inclusive interval [0,currentLength−1]. The shared
reader interpolates toward older frames and holds the oldest valid integer tap.
There is no implicit newest/oldest safety margin, extrapolation, zero-padded blend
or wrap of the age coordinate. An out-of-range read immediately terminates that
grain and increments `expiredGrains`; it does not clamp or resume later. A valid
launch at age 0 while paused, with positive rate, can have only its silent onset
and expire next sample. A valid launch does not promise a full audible window.

Natural completion wins on the sample after the final window endpoint: a grain
whose duration ended is already inactive and is not reported as expired. Reset
has highest priority, immediately silences and clears all grain state, and zeros
all result flags/counts. It must also reset the shared writer. A held reset keeps
the graph empty; a still-high trigger requests again on the first non-reset sample.

## Windows, gain and finite precision

A grain of N output samples has indices k=0…N−1 and triangular weight
`max(0,1-abs(2*k/(N-1)-1))`. Both endpoints are exactly zero. Odd lengths reach 1;
even lengths have a smaller peak. `activeGrains` counts valid reads on the current
sample, including the zero-weight endpoints and successful launches.

Each linearly interpolated f32 history read is weighted and summed in f64. The sum
is divided by **fixed maxGrains**, then converted once to f32. This is fixed pool
headroom, not active-count normalization, content normalization or a limiter. A
single grain in an eight-slot pool is attenuated by eight. Magnitude stays within
the largest active read magnitude, subject to rounding. Finite PCM above unity,
f32 extrema and subnormals remain supported; the writer sanitizes NaN/infinite
input to zero. No clipping masks the candidate audio.

Cursor and latched-rate stores use exact binary scaling by 2^192 to avoid core
0.4.1's 1e−30 scalar-store floor. The scale is storage encoding, not gain. It does
not increase f64 precision: movement smaller than a large cursor's representable
spacing may round away. Linear interpolation is not anti-alias filtering. Window
cancellation, read-edge expiry, pauses and reset can change sound or truncate
transients. This is not pitch-perfect, time-transparent or streaming-continuity
processing, and there is no real-time/device/listening clearance.

## State and verification

Each slot has five persistent scalars: active bool, window index i32, duration
i32, scaled read age f64 and scaled rate f64. The first-free allocation cache is
transient. The history retains its own fixed buffer/head/length/revision and
transient read cache. Work and storage are bounded by capacity and maxGrains;
processing creates no growing history or per-sample buffers.

Snapshots must include the writer **and every reader sharing it** together.
Continuation is exact only for the same graph/configuration/sample rate and
identical subsequent inputs/controls. Partial-graph restore is unsupported.
Native live-state restore and AudioParam restore are non-atomic; establish safe
host controls before restoring. The writer's reset is logical invalidation, not
secure PCM erasure. These constraints are unchanged by this reader.

`tests/live-granular.spec.ts` uses an independent chronological array plus
absolute rational source positions. It avoids both the ring addressing and the
production age recurrence; exact rational positions retain tiny fractions while
accepted-write and playback movements cancel. Evidence covers 44.1/48/96 kHz,
variable accepted writes, paused/resumed recording, first-free saturation,
same-sample expiry/relaunch, zero endpoint counts, natural completion, latching,
invalid eager operands, wrap/read margins, full finite/tiny PCM, snapshots,
capacity one and maximum capacity with eight slots. The maximum fixture remains
active across ring wrap and records through two wraps.

`tests/live-granular-packed.test.mjs` packages the actual public subpath, installs
an isolated consumer with pinned core 0.4.1, checks public types, renders the
independent three-rate reference and same-schema continuation, and builds actual
Vite worklet/WASM assets. Source/tarball/lock/audio/build hashes and failure phases
are retained. The runner defaults to a fresh `npm ci` consumer. An explicitly
approved local-only `DEN_LIVE_GRANULAR_REUSE_LOCKED_CONSUMER` path instead links
unchanged matching locked dependencies and extracts only den from the real new
tarball; it rejects this mode in CI, archives and verifies the original package,
tarball and lock, and records reuse honestly in provenance. These are offline/build candidates, not human-approved goldens or
browser/device/real-time evidence. A separately verified browser composition may
add bounded browser evidence without changing that limit.

## Small actual-browser composition

`tests/live-granular-browser.test.mjs` uses a muted 48 kHz graph with one grain
and a 64-frame history. Native counters bound the writer and a three-sample
request burst, so a delayed host callback cannot change the expected fill or
drop counts. A paused original ramp supplies a known constant source identity.
Every observed output sample is compared to its independent triangle-window
value using a native frame/launch counter, rather than fitting output RMS.
Changing onset controls while that grain runs must preserve its latched motion
and duration.

The fixture saves a noninitial positive grain, clears the shared graph, and
creates a different negative history/grain. It renders recording and triggering
off with every saved control before restoring the entire graph; the negative
mutation must still be audible in the muted observation path until restore.
The recovered positive history and window phase must match the sample oracle.
Resumed writes then overwrite the original source identity and must permanently
expire the grain. Empty-history rejection and held reset remain separate checks.
An independent chronological/source-identity oracle exercises the composition
at three rates before the actual browser gate. This is bounded native behavior,
not device capture, scheduling infrastructure, runtime clearance or an acoustic
listening judgment.
