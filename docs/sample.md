# Resident sample, multisample and granular candidates

Status: **CANDIDATE**. These are bounded DSP building blocks for catalog §3.
No listening approval, bandlimited claim, browser/host delivery proof, streaming,
asset loader, hardware latency or real-time deadline guarantee is implied.

## Public entry and ownership

Import `residentSample`, `samplePlayer`, `multisamplePlayer`, `granularSource`
and their configuration/control types from `@denaudio/den/sample`. Create named
subgraph instances with native `instantiate`. One resident sample can be shared
by multiple readers; player/grain state is private to each instance.

A resident is **mono**, has a fixed capacity of 1–65,536 f32 frames and a fixed
source rate in [8,000,192,000] Hz. Its current loaded length is independent of
capacity. Each player's `sampleRate` is its processor's `ctx.sampleRate`.
Decoding, channel selection/downmixing and finite-PCM validation belong in the
caller, outside audio processing. Channel/rate changes require a newly configured
resident; there is no embedded file format or mutable sample-rate metadata.

Use the existing native ingress, for example:

```ts
const sample = instantiate(residentSample,
  { capacity: 65536, sourceSampleRate: 48000 }, { name: 'sample' });
const load = event<{ data: Float32Array }>({
  from: 'main', name: 'load', capacity: CAPACITY_16,
  payloadCapacity: sample.capacity * Float32Array.BYTES_PER_ELEMENT,
});
load.onReceive(({ data }) => sample.load(data));
```

Validate bytes/frames on the sending side. Send at most the declared capacity,
and handle native transport overflow/rejection. In the verified native offline
path, a typed-array payload larger than the per-slot budget is silently truncated
before `load` sees it; `length()` then reflects that truncated input. Do not rely
on transport rejection to validate a full asset. The DSP `load` itself truncates
an input longer than the resident to capacity; an empty input unloads. A shorter
replacement leaves unreachable bytes in the fixed buffer but all readers clamp
to the new length, so old data cannot leak into playback. The unused tail remains in native snapshots
until overwritten; replacement/unload is logical invalidation, **not secure erasure**.

**Loading is not callback-free.** `Buffer.copyFrom` is a bounded native
`memory.copy` in the process message-dispatch phase, before that quantum's audio
samples. Prepare/decode outside the callback, preload with playback gated off,
and start audible playback only after the delivery boundary is established by
the host. There is no new loader or acknowledgement protocol here. The
postMessage fallback can allocate on the audio thread; offline tests do not
establish live transport safety.

Specify `CAPACITY_16` explicitly. Core 0.4.1 allocates the payload budget once per
ring slot: at the maximum resident size, 16 × 65,536 × 4 = 4 MiB for the payload
ring, plus 256 KiB PCM and small ring/state overhead. Multiple ingress/resident
pairs multiply this budget. Sixteen distinct maximum-capacity residents, each
with its own 16-slot ingress, reserve 64 MiB payload + 4 MiB PCM before ring/state
overhead; that bank is materially more expensive than 16 zones sharing one resident
(4 MiB payload + 256 KiB PCM). Simultaneously queued full loads also copy 4 MiB
into the bank at a boundary and are unsuitable for an unmeasured audible reload.
The native default ring has 256 slots and would use
64 MiB payload space for that same capacity. Capacity is not an allocation-free
loading claim or a recommended live reload size.

PCM, loaded length and revision are persistent native snapshot state. The revision
increments as a wrapping i32 on every load, including empty input. Readers compare
for inequality, not ordering, so signed/unsigned wrap preserves invalidation.
The bounded 16-message ring cannot wrap the whole 32-bit revision between adjacent
audio ticks. Snapshots promise exact continuation only for the **same graph,
configuration, resident metadata and rate**; they are not a portable sample bank
format or cross-configuration migration contract.

## Playback and slices

`samplePlayer({ sampleRate, sample, startFrame?, endFrame?, loop?, releaseFrames? })`
accepts `tick({ gate, trigger, reset, rate })` and returns
`{ output, active, position, missing }`.

- Slice boundaries are construction-time frame indices `[startFrame,endFrame)`.
  The end intersects the loaded length; an empty intersection is missing/silent.
- `rate` is a signed ratio clamped to [-16,16]. The increment is
  `rate * sourceSampleRate / sampleRate`. Zero holds; negative starts at `end-1`.
  Rate changes while playing change direction/speed without repositioning.
- Gate-rise or a true trigger while gate is high starts/restarts. Trigger is
  level-sensitive, so holding it repeats the initial sample. Reset has priority;
  held reset is silent, then a still-high gate restarts on the next tick.
- Linear interpolation explicitly wraps the second tap at the loop boundary.
  One-shot interpolation holds the final frame until the phase exits `[start,end)`.
  No index relies on unworklet's automatic wrap. Length 0/1 is defined and bounded.
- Gate-off applies a linear `releaseFrames` ramp; the first off sample subtracts
  `1/releaseFrames`, so release 1 stops immediately. Default 0 stops immediately.
  Natural one-shot exhaustion stops independently. Use an envelope for a richer
  articulation law. `active` describes the current emitted sample, including a
  zero PCM value; it does not predict whether the next sample is active.
- Replacement invalidates the current playback. A gate held high does not
  silently restart a new asset; a fresh gate-rise/trigger can start it. A load and
  fresh trigger in the same quantum use the newly copied asset.
- Nonfinite rates use bounded fallback/saturation; NaN means zero speed.
  Nonfinite PCM taps become zero individually, without poisoning reader state.
  Fractional position/control state uses exact binary scaling internally to avoid
  the native scalar-store flush below 1e-30; finite extreme PCM is not reduced to
  a ±1-only assumption. Tiny/subnormal controls are tested against full finite PCM.
- Public resident `read(position,start,end,loop)` also intersects end with loaded
  length. Non-loop out-of-range positions hold the nearest valid endpoint; it is
  not a zero-padded reader. Direct frame positions saturate to the signed i32 index range, with NaN
  selecting start; start/end are i32 nodes. The player/granular methods maintain
  their own tighter phase/control bounds. Player/grain activity masks enforce their own silence.

Loop interpolation smooths fractional lookup but **does not make a discontinuous
loop seamless**. Loop crossfades, automatic zero-crossing search, time-stretching,
bandlimited rate conversion and seamless dynamic asset replacement are not in this
candidate. A high-frequency sine played at double rate demonstrably aliases.

## Multisample mapping

`multisamplePlayer({ sampleRate, zones, releaseFrames? })` accepts
`tick({ key, velocity, gate, trigger, reset, rate })` and returns
`{ output, active, zoneIndex, missing }`.

There are 1–16 fixed zones. Each specifies `sample`, integer `keyLow/keyHigh`,
normalized `velocityLow/velocityHigh`, integer `rootKey`, optional `tuneCents`
(±2,400), `gain` (±4), and optional slice/loop configuration. All endpoints are
inclusive; the first matching zone wins overlaps. Inputs clamp to MIDI 0–127 and
velocity 0–1; fractional keys are supported for transposition inside a zone.

Zone, key and velocity latch at note-on. Root-key tuning multiplies the rate by
`2 ** ((key-rootKey)/12 + tuneCents/1200)`, then the player limits the final signed
ratio to ±16. Output gain includes latched velocity × zone gain. No match returns
zone -1/missing/silence. A matching but unloaded sample remains the selected missing
zone; there is no hidden fallback. A new note resets other zone players, so this is
a **monophonic selector**, not a polyphonic allocator or release-tail mixer.
Clipping/limiting is not implicit; zone gain can exceed unity. Preserve f32
headroom when applying gain: extreme finite PCM multiplied by a gain above one
can overflow the output type; the raw-resident finite-range proof is not an
unbounded-gain guarantee.

## Granular source

`granularSource({ sampleRate, sample, maxGrains, seed?, loop? })` accepts
`tick({ gate, reset, positionFrames, jitterFrames, rate, durationSeconds, densityHz })`
and returns `{ output, activeGrains, onset, dropped, missing }`.

- Fixed pool of 1–32 grains. First free slot wins; a full pool drops the onset
  instead of stealing a grain or allocating memory. Density is limited to
  0–2,000 Hz. Gate-rise creates an initial grain even at zero density.
- Position and uniform signed jitter are in source frames. Jittered start clamps
  into the loaded asset. Signed pitch rate and source/host conversion match playback.
  Position, rate and duration latch at onset; later controls affect new grains.
- Duration rounds to the nearest output frame, bounded to 3 frames–2 seconds.
  The triangular window is `max(0,1-abs(2*age/(duration-1)-1))`, exactly zero at
  both endpoints. This is not a Hann window or a constant-overlap-add guarantee.
- `seed` is an integer 1–2,147,483,646. Park–Miller 48,271 modulo 2,147,483,647
  advances for every scheduled onset, including a dropped onset. Reset restores
  the seed; snapshot restore preserves it and every grain. Repeatability is for
  identical controls/rate/configuration. The oscillator/noise PRNG is not reused.
- Scheduling phase is f64. Nominal onset times can round by one output sample at
  nonintegral periods; this candidate is not a host musical clock or event output.
- `loop:true` wraps each grain within the whole resident. `loop:false` masks
  reads outside the asset to zero. Gate-off stops scheduling while existing
  windows finish; reset or asset replacement cancels all existing grains.
- Sum is divided by configured `maxGrains`, not active count. This gives a simple
  overlap bound for finite bounded PCM and avoids changing gain as grains appear,
  but sparse pools are correspondingly quieter. It is not loudness normalization.

Live-buffer recording/freeze, read/write-age rules, stereo grains, advanced
crossfades, spectral synthesis and streaming are separate future work.

## Evidence and acceptance

The native-ingress probe and `tests/sample.spec.ts` use synthetic original
impulse/ramp/sine PCM, independent numeric references, 44.1/48/96 kHz playback,
missing/short/empty replacement, finite controls, exact snapshot continuation,
zone boundaries, seeded grain onset/window/drop and explicit alias evidence.
Maximum resident/ring allocation and maximum pool/zone checks are separate from
a hardware performance claim. Packed-consumer evidence is produced by
`tests/sample-packed.test.mjs`; its manifests and audio are always CANDIDATE.
No existing approved audio baseline is replaced.

Maximum capacity is a functional offline bound, not a recommended live preset.
`makeProcessor({ zoneCount: 1, grainCount: 4 })` in the isolated consumer is a
modest composition for separate browser acceptance; its graph holds the fixture
clock/gates until native loaded length is nonzero, so delayed delivery cannot
consume the audition before PCM arrives. The maximum fixture uses
16 zones and 32 grains. Per-module 1/4/32-grain and 1/16-zone measurements are
reported separately. The public compile driver cannot inject load messages, so
these timing diagnostics explicitly start unloaded and must not be presented as
audible-pool/device performance. The actual loaded offline renders separately
prove maximum grain activity, PCM, onset/drop and continuation behavior.
