# Bounded resident wavetable candidate

`@denaudio/den/wavetable` exports `wavetableSource`, `WavetableConfig` and
`WavetableControls`. This is a candidate source, not an approved sound or a
bandlimited wavetable engine. Existing oscillator, instrument and sounds are unchanged.

## Layout and ingress

Instantiate one `residentSample` from `@denaudio/den/sample`, then pass that shared
resident to `wavetableSource`. The source does not create an asset loader or a
second PCM buffer. Use the resident's existing native `event<{data:Float32Array}>`
and `sample.load(data)` ingress, outside audible playback when practical. Native
dispatch copies PCM at a block boundary; this is not callback-free streaming.

PCM is frame-major mono: concatenate complete cycles of equal length. Do not
duplicate the first sample at the end. `frameLength` is an integer 4..4096;
`frameCount` is an integer 1..16. Their product must fit `sample.capacity`, which
must be 4..65536. Construction rejects invalid layouts. Extra loaded PCM after the
required product is ignored. A shorter or empty asset produces zero with
`missing=true` for the whole source, rather than playing a partial table.

The maximum layout holds 16 × 4096 = 65536 float32 samples (256 KiB). With the
sample lane's explicit CAPACITY_16 ingress and 262144-byte payload capacity,
the event payload arena contributes another 4 MiB, plus native metadata and
I/O/state. Ingress belongs to the shared resident, not to each oscillator. A
source has two linear readheads/four bounded PCM taps regardless of frame count,
plus 36 bytes of declared scalar values before native layout/alignment. There is
no unrolled table bank, mipmap builder, FFT, dynamic allocation or JS DSP callback.

## Controls and sound

- `sampleRate`: finite 8000..192000 Hz, fixed at construction.
- `phaseCycles`: initial/reset phase in [0,1), default0.
- `frequencyHz`: float32 signal, clipped to [0,.45 × host sample rate]. Negative
  values and NaN become0; positive infinity saturates. At zero Hz phase holds.
- `frame`: fractional frame index, clipped to [0,frameCount−1]. NaN becomes0.
  Frame interpolation is linear without smoothing or wrap of the frame selector.
- `reset`: level-sensitive. True emits the configured phase on that sample,
  then advances. A held reset repeats the same phase, though morph can change.
- Return: `{output, missing}`. Output is not peak-normalized or hard-clipped.

Both selected cycles wrap independently from their last PCM sample back to their
own first sample, then their outputs are mixed. A cycle never interpolates into
the next morph frame. `sourceSampleRate` metadata is intentionally irrelevant:
each frame is one cycle, so frequency is controlled in host Hz, not playback-rate
conversion. The resident reader substitutes zero for NaN/infinite PCM taps;
arbitrary finite PCM amplitude is retained. Interpolated values are not stored in
float scalar scratch states, preserving tiny/subnormal samples.

Every resident revision, including equal-length replacement and revision integer
wrap, restarts the configured phase. Phase still advances while the asset is
missing. Replacement restarts it again when data arrives. There is no replacement
crossfade. No note/gate policy, envelope, gain stage or automatic unison is added.

Phase and frame materialization use exact power-of-two-scaled f64 native state to
avoid the upstream scalar flush below 1e-30. Tiny positive float32 frequencies
therefore accumulate from zero, subject to ordinary f64 rounding once added to a
nonzero phase. No artificial minimum musical frequency is imposed. State uses
the existing native snapshot mechanism. Only identical graph/config/sample-rate
continuation is tested; PCM contents and the shared resident revision are part
of that snapshot. No new serialization or cross-schema migration guarantee.

The phase scale is 2^1020 so even f64 `Number.MIN_VALUE` initialization survives
the native guard. Phase is always wrapped below 1 before scaling, leaving over
16× finite headroom; advance/multiply/read arithmetic occurs only after unscaling.
Morph is a float32 control, so its separate 2^128 scale is sufficient and remains
far from f64 overflow at frame 15. Scaled state is never multiplied by PCM.

## Quality boundaries

Linear cycle interpolation attenuates high harmonics but is not antialiasing.
High table harmonics fold even with legal fundamental frequency. Morph scanning,
abrupt replacement, reset and frequency modulation can add bandwidth. There are
no pitch bands or runtime harmonic rejection in this candidate. Pre-bandlimited
assets may help static playback; they do not prove modulation is alias-free.

Tests cover 44.1/48/96 kHz, independent periodic interpolation and sine-frequency
oracles, exact phase/reset/hold, frame1/length4, wrapped endpoints, missing/short
assets, revision wrap, max resident, full finite/subnormal/nonfinite PCM and exact
snapshot continuation. An explicit high-harmonic test preserves the known folded
alias instead of labeling the source bandlimited. Packed consumer evidence is
separate from human listening, browser scheduling and hardware real-time proof.
