# Resident take recorder candidate

Status: **CANDIDATE / NOT_CLEARED**. Catalog §3 describes sample/live-buffer
sources, fixed-capacity storage, and read/write competition. This module adds a
bounded native take writer that composes with the existing sample readers.
It is not a microphone permission layer, recorder application, rolling history,
overdub looper, streaming engine, or realtime/listening approval.

## Entry and scope

Import `residentTakeRecorder`, `ResidentTakeRecorderConfig`,
`ResidentTakeRecorderControls` and `ResidentTakeRecorder` from
`@denaudio/den/resident-recorder`. Instantiate once inside a native processor:

```ts
const take = instantiate(residentTakeRecorder,
  { capacity: 65536, sampleRate: ctx.sampleRate }, { name: 'take' });
const player = instantiate(samplePlayer,
  { sampleRate: ctx.sampleRate, sample: take.sample, loop: true },
  { name: 'player' });
// In forSample, call the writer once, then the readers, in the intended order.
const status = take.tick({ input, record, reset });
```

Capacity is an integer in 1–65,536 mono source frames, immutable after graph
construction. `sampleRate` is the incoming processor rate, finite 8–192 kHz.
The maximum take lasts about 1.486 s at 44.1 kHz, 1.365 s at 48 kHz, or 0.683 s
at 96 kHz. Changing the configured rate does not resample input. There is no
hidden monitor output: route the original input separately if monitoring is
wanted. All recording and reading is graph-native unworklet 0.4.1.

## Sample-accurate write contract

- Initially length and revision are zero, and reads are missing/silent.
- `record:true` appends exactly one frame if length is below capacity.
  `record:false` pauses without changing any exposed PCM or length.
- At capacity, recording stops without wrap or overwrite. Dropping and raising
  record does not start another take. Reset is needed to start at frame zero.
- `reset:true` has priority, sets length and loaded-prefix boundary to zero and
  suppresses recording. It increments the wrapping i32 revision on every held
  reset tick. A still-high record resumes on the first non-reset tick.
- `tick` returns `{written,full,length}` for this tick after the operation.
  `written` includes recording a silent or sanitized frame. `full` is true on
  the tick that writes the final frame; no extra input is accepted thereafter.
- Call `tick` exactly once per incoming sample. Native statement order controls
  visibility: a read before `tick` sees the prior take, and a read after sees
  the completed append/reset. PCM is stored before length is advanced; no
  partially initialized frame becomes exposed. There is no inter-thread reader
  or concurrent host-write contract.

There is no circular overwrite, so frame zero stays frame zero until reset/load.
The valid frame age can be computed from the current length; paused time does
not add frames or silence. This is a growing finite take, not a continuously
advancing live history with a moving read/write safety margin.

## Existing sample reader compatibility

`take.sample` implements the unchanged `ResidentSample` interface. It can be
passed directly to `samplePlayer`, `multisamplePlayer` and `granularSource`.
The direct `read` has the existing bounded linear interpolation, slice, looping,
NaN-position and nonfinite-tap policies; the inaccessible sentinel cannot be
selected by a reader. Interpolation spans a loaded-prefix/recorded-suffix
boundary normally.

`sample.load(data)` is the existing native Float32Array event-boundary operation:
it replaces the take, truncates to capacity, sets length to that truncated
length, and increments revision. Empty data logically unloads. Subsequent
recording appends after the loaded prefix. If load and record occur in the same
quantum, native message dispatch installs the prefix before the audio ticks;
reset at the first tick can still empty it. No decoding, file/device I/O, new
transport, acknowledgement or serializer is added. Follow the input budgeting,
preload and callback-copy limitations in [sample.md](sample.md).

Appending does not change revision. Existing readers observe the growing length
on each call/tick rather than a frozen initial bound. In particular, loop period
grows, and grains whose positions move within the newly valid region can read
it. A one-shot that already became inactive does not revive just because length
grows. For stable loop/grain boundaries, stop recording before playback.
Reset/load changes revision and invalidates existing playback/grains under
their normal contract; a held player gate is not a fresh trigger. Trigger/gate
and read/write order remain explicit responsibilities of the composition.

## Amplitude and bounded storage

Core 0.4.1 scalar buffer stores flush magnitudes below 1e-30. Direct f32 recording
would therefore discard some representable signal values. This candidate uses:

1. `loadedPCM`: C f32 frames, populated only by native event `copyFrom`.
2. `recordedPCM`: C+1 f64 frames, recording `f64(input) * 2^128`.
3. `loadedPrefixLength`: the native i32 boundary selecting the loaded prefix or
   recorded suffix. Reset makes it zero; load makes it the new take length.

Exact power-of-two scaling keeps every finite nonzero f32 input above the native
store floor and below f64 overflow. Readers divide by the same factor. It is a
storage encoding, not audio gain/normalization: decoded finite values retain
their amplitude, including maximum f32 and the smallest f32 subnormal. Signed
zero records as positive zero. NaN and ±Infinity record as zero, without relying
on the output scrubber. Event-loaded invalid values are independently sanitized
at read taps, matching the original resident sample.

The extra recorded frame is an unreachable sentinel. Paused/full/reset ticks
write only zero there. Native `select` evaluates both branches, so using a
sentinel avoids accidentally rewriting any exposed sample. Both buffers are
persistent; buffer storage is exactly `12*C + 8` bytes, 786,440 bytes at maximum
capacity, plus three i32 persistent states, transient read position, normal
runtime/IO overhead, and any caller-created ingress ring. Both read branches
are evaluated; the split costs two bounded memory reads per interpolation tap.

Reset and short/empty replacement are **logical invalidation, not secure
erasure**. Unreachable loaded/recorded tails remain in snapshots until later
overwritten. No growing allocation or clearing pass occurs per reset. Native
snapshots include both buffers, length, loaded-prefix boundary and revision;
the transient read-position cache is excluded. Exact continuation is promised
only for the same graph, configuration and sample rate. It is not a portable
audio-file format or an arbitrary live-restore guarantee.

## Evidence and limits

`tests/resident-recorder.spec.ts` compares every output sample against an
independent scalar oracle at 44.1/48/96 kHz. Coverage includes pause/full/held
reset, pre/post-write reads, prefix-to-suffix interpolation, short/empty/oversize
replacement, capacity one/65,536, f32 extremes/subnormals/nonfinite input,
inaccessible sentinel and unchanged loaded bytes, growing player/granular
composition, wrapping revision and exact snapshots.

`tests/resident-recorder-packed.test.mjs` installs the real tarball into an
isolated locked consumer, checks public TypeScript, renders native DSP against
the independent oracle, verifies same-schema snapshot continuation, and builds
the actual Vite worklet/WASM at 48 kHz. Manifests retain exact source, tarball,
consumer-lock, rendered audio and build hashes. The consumer audio is original
synthetic signal, **CANDIDATE**, without normalization or a limiter.

The separate `tests/capture-freeze-browser.test.mjs` requires actual 48 kHz
worklet recording, deterministic native capture limits, pause/full-stop,
existing-player readback, prefix/suffix interpolation and native PCM/history
restoration. It uses synthetic graph input; no microphone or device is opened.
This browser stage must pass on the exact final head before merge.

Offline multirate success, worklet build and actual browser execution are separate
evidence. There is no device capture, listening approval, realtime deadline,
seamless take transition, antialiasing, long-form recording or streaming claim.
Core's non-48-kHz browser loader restriction remains unchanged.

Live core 0.4.1 restoration copies DSP state before restoring host AudioParam
values. Old record/reset/player controls can therefore act on restored state
before the saved controls arrive. The browser fixture first renders the saved
record, play, input, limit, position and reset controls, then restores the take.
The earlier already-full-buffer pass masked the write hazard and is not general
atomic-restore evidence. Browser playback checks are functional PCM/readback
checks; phase-aligned quantum continuation is separately tested offline. See the
[observed frozen-tail restore boundary](freeze-reverb.md#live-browser-restore-ordering).
