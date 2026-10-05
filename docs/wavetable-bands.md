# Prepared pitch-band wavetable candidate

`@denaudio/den/wavetable` additionally exports `prepareWavetableBands`,
`bandedWavetableSource`, `PreparedWavetableBands`, `WavetableBandsOptions` and
`BandedWavetableConfig`. The unbanded `wavetableSource` retains its layout and
control contract with the cycle-local precision correction documented separately.
Oscillator and instrument behavior is unchanged. This candidate implements the original catalog group's
host-prepared pitch-band assets and shared native reader; it is not an approved
sound or a claim of equivalence to another synth.

## Host preparation and provenance

Call `prepareWavetableBands({ frames })` on the host, outside audio processing.
Supply 1..16 `Float32Array` mono cycles of equal power-of-two length 16..4096.
A cycle contains no duplicate final endpoint. All input samples must be finite.
The helper does not decode files, load assets or assume a license for user data.
Tests use original analytic sine/cosine combinations, silence and synthetic
finite/nonfinite edge fixtures; no third-party audio or proprietary tables.

A host-only radix-2 FFT obtains each cycle's complex spectrum. The first band's
positive harmonic limit is N/2−1; each next limit is floor(previous/2), ending at 1.
DC is retained in every band. Only conjugate pairs through that limit are kept;
the table Nyquist bin is omitted. Explicit conjugate symmetry and inverse FFT
produce real cycles. Original DC, retained gain and phase are preserved within
FFT/float32 roundoff. There is no peak or per-band normalization. Finite source
PCM can overshoot after harmonic truncation: if any reconstructed value becomes
nonfinite when converted to float32, preparation throws `RangeError`, without
clamping or returning a partially prepared asset. Nonfinite input also throws.
The input cycles are never modified.

The result is an ordinary local object `{data, frameLength, frameCount,
harmonicLimits}`. `harmonicLimits` is frozen, descending and explanatory; it is
not a transport protocol. Native construction derives the same fixed schedule.
Editing a source frame means preparing it again and loading the resulting full
PCM through the existing resident. This is not a new serializer or asset manager.

## Fixed layout, capacity and ingress

The resulting `data` is band-major then frame-major: band0/frame0 cycle,
band0/frame1 cycle, …, band1/frame0 cycle, …. Required PCM length is
N × morph-frame count × band count. Both host preparation and native construction
reject layouts larger than 65536 samples. Native construction also rejects a
resident with insufficient capacity. There are 3..11 bands. Examples:

- 512 samples × 16 frames × 8 bands = 65536 samples, the full 256 KiB resident
- 1024 × 7 × 9 = 64512 samples
- 2048 × 3 × 10 = 61440 samples
- 4096 × 1 × 11 = 45056 samples

Host preparation allocates the output plus four reused float64 work arrays,
32N bytes (at most 128 KiB), excluding the caller's original frames and ordinary
object overhead. Transform cost is O(frameCount × bandCount × N log N).
No FFT, arbitrary JS, allocation or user callback is invoked by the native tick.

Instantiate the existing `/sample` `residentSample`, then pass it with matching
`frameLength`/`frameCount` to `bandedWavetableSource`. Load `prepared.data` with the
resident's established native `event<{data:Float32Array}>` and `sample.load(data)`.
The native event copies PCM at a block boundary. For the full layout the existing
CAPACITY_16 ingress and 262144-byte payload reservation contribute 4 MiB of event
arena, in addition to the 256 KiB resident and native I/O/state/metadata. The reader
adds eight integer resident reads (16 underlying PCM taps), four local cycle
interpolations and 76 bytes of declared scalar
state before native alignment. Multiple sources can share the resident/ingress.
There is no extra native PCM bank, new loader, streaming or upstream patch.

A short or empty load is entirely silent with `missing=true`. Extra PCM after
the required layout is ignored. Construction dimensions stay fixed; replacing
with a different-dimensional asset requires a matching graph or intentionally
adapted data. Length alone cannot certify harmonic content or identify a same-size
layout mismatch. The caller must load the matching prepared layout. Arbitrary
PCM is still protected by the resident's nonfinite-tap-to-zero rule; the native
reader does not validate its spectrum or metadata.

## Pitch bands, frame scan and state

The controls and result match `WavetableControls`: `{frequencyHz, frame, reset}`
and `{output, missing}`. The source rate is finite 8000..192000 Hz, fixed at
construction. Resident `sourceSampleRate` does not affect cyclic pitch.

`frequencyHz` is clipped to [0,.45 × sampleRate]. NaN/negative/negative infinity
become0; positive infinity saturates at the upper limit. Zero Hz holds phase.
`frame` is a fractional index clipped to [0,frameCount−1], with NaN→0. Neighboring
frames interpolate linearly without frame-selector wrap or control smoothing.
`phaseCycles` is the finite initial/reset phase in [0,1), default 0.

For each bright band with limit H, its transition to the next darker band starts
at .225 × sampleRate/H and finishes at .45 × sampleRate/H. The mix is linear in
frequency. Transitions do not overlap; any gap holds the darker band. The last
H=1 band is held through the accepted .45 × sampleRate frequency cap. Thus every
represented positive table harmonic with nonzero band weight is below or equal
to .45 × sampleRate for static playback. This statement concerns the retained
base harmonics only, not the images of linear table interpolation.

The reader retains each local fractional phase before adding the cycle base,
fetches two integer-position resident reads per cycle, interpolates periodically
within each of four cycles, then
interpolates their two frame pairs and the pitch bands. Each cycle wraps to its
own first sample, never to another frame/band. There is no output limiter or gain
normalization. Pitch/frame control changes are instantaneous; rapidly jumping
bands or frames is not click-free. Band transition continuity is a control-domain
property, not a promise that arbitrary modulation adds no bandwidth.

Reset is level-sensitive: emit the initial phase on that sample, then advance.
A held reset repeats the initial phase while pitch-band/frame selection can vary.
Every resident revision, including equal-length replacement and signed integer
wrap, also restarts phase. There is no asset-replacement fade. Phase advances
while an asset is missing; a subsequent load restarts it. Tiny frequencies and
frame mixes use exact binary-scaled f64 control state; phase uses 2^1020 so even
f64 `Number.MIN_VALUE` survives native scalar flushing. Arithmetic is unscaled
before combining with PCM, and all declared state remains finite.

Native snapshots include resident PCM, revision and reader state. Exact
continuation is tested only for identical graph/configuration/sample rate. No new
snapshot API or cross-schema/rate migration is promised.

## Quality boundary and evidence

Pitch bands reject high source harmonics that otherwise fold at high static
pitch. Linear interpolation still attenuates retained harmonics and generates
image aliases. The test suite explicitly measures one such residual image
instead of labeling the reader brickwall-bandlimited. Rapid frame scan, FM/PM,
reset, sync, warp and asset replacement can add bandwidth; static truncated
assets do not make them alias-free. No automatic oversampling is added.

Independent direct real-DFT preparation checks and Fourier coefficients verify
retained/removed harmonics, DC/gain/phase, silent/edited frames and rejection of
float32 overflow. Native tests cover 44.1/48/96 kHz, sweep and every band-transition
boundary, frame morph, control extremes, held reset/zero Hz, missing/short/edited
native assets, revision wrap, invalid/subnormal PCM, tiny phase/frequency/morph,
full capacity and exact snapshot continuation. The packed isolated consumer
imports only public `/wavetable` and `/sample`, checks strict types, loads full
native assets, renders and compares an independent piecewise reader oracle,
checks spectral content and replacement, and records source/package/audio hashes.

Generated WAVs and manifests are CANDIDATE. Compile-driver memory/timing is
reported with its unloaded-state limitation; loaded offline ingress/render tests
are separate. These are neither human listening approval nor browser/hardware
real-time performance proof.
