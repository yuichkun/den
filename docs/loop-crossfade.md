# Crossfaded resident loop candidate

Status: **CANDIDATE**. This additive reader uses the existing resident PCM ingress,
native state and linear interpolation. It does not change `samplePlayer`.
No listening approval, seamless arbitrary-content claim, antialiasing, streaming,
loader, time-stretching or browser/realtime deadline proof is implied.

## Entry and effective period

Import `crossfadedLoopPlayer` and `CrossfadedLoopConfig` from
`@denaudio/den/loop-crossfade`; import `residentSample` and the shared
`SamplePlayerControls` from `@denaudio/den/sample`.

Construction accepts `{ sampleRate, sample, startFrame = 0,
endFrame = sample.capacity, crossfadeFrames, releaseFrames = 0 }`.
The fixed slice is `[startFrame,endFrame)`; `crossfadeFrames` is an integer in
`[0,floor((endFrame-startFrame)/2)]`. Zero explicitly disables the overlap.
Resident and host rates follow the existing [8,000,192,000] Hz contract.
`releaseFrames` is an integer in `[0,ceil(sampleRate*10)]` output samples.

For the currently loaded asset define:

- `S = startFrame`, `E = min(endFrame, sample.length())`, `L = max(0,E-S)`
- `F = min(crossfadeFrames,floor(L/2))`
- `P = L-F`, the **effective loop period in source frames**

The playback phase `q` traverses `[0,P)`. The primary read position is
`x = S+F+q`. In the last `F` source frames of that cycle (`q >= P-F`),
read the tail at `x`, read the head at `S+q-(P-F)`, and linearly blend
`(1-w)*tail + w*head`, where `w = (q-(P-F))/F`. Outside the overlap,
read only the primary position. Overlap taps use nonwrapping resident linear
interpolation, which holds the last endpoint between `E-1` and `E`.
At the phase seam the head approaches `S+F`, the next primary start.
When `F=0`, use ordinary wrapping linear interpolation over the whole slice.

This makes the repeated cycle `L-F` source frames long, rather than `L`.
For fixed nonzero rate, the cycle lasts `P / abs(rate*sourceRate/hostRate)`
output frames (not necessarily an integer). At unit rate with equal rates,
an eight-frame slice with two overlap frames repeats every six samples.
The first `F` source frames appear only as the incoming overlap head;
forward triggering starts at `S+F`, not at the asset attack at `S`.
Do not use this reader when an unchanged loop duration or dry attack is required.

The law is unity-sum linear, not equal-power. It bounds the output peak by the
largest finite source tap before release gain. Correlated equal signals do not
receive a +3 dB bump. Different phases can cancel or comb; mismatched transients
can soften, repeat or smear. Even though the continuous interpolated overlap
meets at its endpoints, one-sample overlaps or large playback increments can
still produce large adjacent output steps. This is not a universal click-remover.

## Timeline, controls and lifecycle

`tick({ gate, trigger, reset, rate })` returns
`{ output, active, position, phase, periodFrames, crossfadeFrames, missing }`.
`phase` and `position` describe the current sample before advancement.
`periodFrames` and returned `crossfadeFrames` report effective `P` and `F`.

- `rate` is signed, clamped to [-16,16], with NaN treated as zero and infinities
  saturated. Advance by `rate * sample.sourceSampleRate / sampleRate`.
  Zero holds the current phase. A change in direction changes only advancement.
- Gate-rise, or a true trigger while gate is high, starts/restarts. Forward/zero
  starts at `q=0`; negative starts at `q=P-1` (primary position `E-1`). Reverse
  traverses the **same blended periodic waveform backwards**, including its
  overlap. It does not choose a different, direction-dependent fade waveform.
  Holding trigger repeats that initial sample.
- Reset wins over trigger/gate, is silent, and resets phase to zero and gate
  memory to low. Releasing reset with gate still high starts again.
- Gate-off release matches `samplePlayer`: the first off sample subtracts
  `1/releaseFrames`; zero or one stops immediately. Release never exceeds one.
  `active` describes the current emitted sample, even when the PCM value is zero.
  Inactive playback freezes its phase; inactive output is zero.
- Each resident load, including an empty or identical replacement, invalidates
  playback and resets its phase. Held gate does not restart the new asset.
  A fresh gate-rise/trigger on that tick can start the newly loaded data.
- A shorter replacement clips both heads and reduces `F` and `P`. One available
  frame gives `F=0`, `P=1` and a constant sample. Empty slice gives missing true,
  silence, and both reported lengths zero. No stale PCM tail is read.
- `position` is the primary source position, not a unique representation of both
  blended taps. While missing it reports `S`; phase is zero.

Use at most one `tick` per player instance per output sample; different named
players can share one resident and their returned values may be consumed after
other shared-resident reads. All playing state and resident PCM remain native
snapshot state. Source interpolation splits local integer/fractional coordinates before adding
slice/head offsets, preserving meaningful tiny-phase contributions against large
finite PCM. Phase accumulation uses f64 arithmetic; increments below the f64
resolution at the current phase can still be lost. Public phase/position
diagnostics are f32 and are not a higher-precision transport.
Same-graph/configuration/metadata/rate snapshots resume exactly;
there is no serializer, asset migration or cross-rate snapshot contract.
See [resident ingress and replacement constraints](sample.md) before loading.

## Verification

Focused and isolated packed-package checks cover independent scalar timelines,
source/host conversion at 44.1/48/96 kHz, forward/reverse/fractional and large rates,
overlap endpoints, short and missing slices, headroom/cancellation/transients,
reset/release/retrigger, replacement, deferred shared reads and exact snapshots.
Generated WAV files are CANDIDATE evidence, never approved goldens.
