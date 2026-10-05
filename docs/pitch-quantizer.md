# Octave-periodic musical pitch quantizer

`@denaudio/den/pitch-quantizer` exports `pitchQuantizer`, `PitchQuantizerConfig`, and `PitchQuantizerOutput`. This is the catalog group 5 musical-quantize candidate. It quantizes a pitch-control signal using native unworklet 0.4.1 DSP. It does not detect pitch in audio, tune an audio recording, quantize event timing, or deliver MIDI to a host.

## Construction and use

```ts
import { instantiate } from '@unworklet/core';
import { pitchQuantizer } from '@denaudio/den/pitch-quantizer';

// Inside defineProcessor, outside forSample:
const quantizer = instantiate(pitchQuantizer, {
  pitchClasses: [0, 2, 4, 5, 7, 9, 11],
  hysteresis: 0.125,
}, { name: 'cMajor' });

// Inside forSample, exactly once per sample:
const result = quantizer.tick(pitchControl, reset);
// result.pitch is f32; result.degree and result.octave are i32.
```

Pitch uses semitones on the MIDI-coordinate axis: 60 is C4; negative and fractional controls are valid. Each allowed pitch is `12 * octave + pitchClasses[degree]`. `octave` is that integer multiplier, not a printed musical octave number. For example, pitch 60 has octave multiplier 5. To transpose a scale, prepare its transposed offsets in `[0,12)` before construction. No tuning file loader, tonic control, Hz conversion, gate policy, or scale-name registry is included.

- `pitchClasses`: 1 through 128 numbers. Entries must be finite in `[0,12)`, including after conversion to IEEE f32. The module copies, f32-rounds, and sorts them ascending. Exact duplicates and duplicates after rounding, including 0/-0, are rejected. The input order has no musical meaning; returned degree indexes the sorted canonical list. A value just below 12 that rounds to 12 is rejected rather than silently wrapping.
- Fractional and microtonal offsets are supported, including representable f32 subnormals. This is not restricted to twelve-tone equal temperament. Offsets finer than f32 precision round to the same value and therefore cannot be distinct degrees. The period remains exactly twelve semitones; non-octave-repeating tunings are outside this module.
- `hysteresis`: optional finite number in `[0,12]` semitones, default 0, converted to f32. It is a construction-time margin, not a time constant. Positive values smaller than the least positive f32 round to 0. Scale structure and margin cannot be changed through a per-sample control.
- Invalid construction inputs throw `RangeError`. These bounded inputs control graph size; no callback-time array allocation or arbitrary JavaScript execution is used.

## Nearest, precision, and invalid controls

On every sample, NaN input maps to pitch 0. All other inputs, including infinities, clamp to `[-16384,16384]`. Quantization then searches the scale; the output itself is not clipped to that range. For example, offset `[6]` can produce pitch 16386 from input 16384. This preserves scale membership at the input-domain endpoints.

Without hysteresis, choose the candidate with the smallest native binary64 absolute distance from the sanitized f32 input. Computed distance equality chooses the lower computed binary64 pitch. If different degrees collapse to that same binary64 pitch, the lower sorted degree index wins. Each class compares the distances of its two bracketing octaves; a midpoint shortcut would not preserve this computational tie policy for all tiny controls. The result is then converted to f32. Thus arithmetic and output rounding are explicit parts of the contract; this is not arbitrary-precision tuning. Fractional degrees that differ in their construction values can produce the same f32 output at a large octave, and exceptionally tiny offsets can also collapse during binary64 octave arithmetic.

The chosen degree and octave are retained as integer state, never reconstructed from the rounded output. They are returned along with pitch, so callers can inspect the selected scale identity even where two f32 output pitches coincide. Internal distance/pitch staging uses exact power-of-two scaling to preserve subnormal f32 values through unworklet 0.4.1's scalar-state denormal floor.

## Hysteresis, reset, and rate

For positive margin `h`, the current degree remains selected while the sanitized input is within the inclusive interval

`[(previousPitch + heldPitch)/2 - h, (heldPitch + nextPitch)/2 + h]`.

Previous and next mean adjacent entries in the periodic sorted scale, including across an octave boundary. Bounds are evaluated as binary64 local-degree midpoints plus the integer octave base. Both boundary equalities retain the held degree. Outside the interval, the result jumps directly to ordinary nearest for the current input; it does not walk one scale degree per sample. For large margins, several neighbors can be passed before a change. A one-degree scale uses the same degree in adjacent octaves as its neighbors.

The first call and every reset-high sample ignore history and emit ordinary nearest immediately. Holding reset high therefore continues to quantize moving input, rather than muting output or pinning one pitch. The next reset-low sample starts hysteresis from the last reset-selected degree. At margin 0, every sample uses ordinary nearest, including its lower-pitch tie policy; there is no history-dependent tie retention.

There is no smoothing, event queue, lookahead, clock, time constant, or sample-rate-dependent state. Call once per sample of the chosen control stream. The same trajectory has the same result at 44.1, 48, and 96 kHz. Existing unworklet snapshots restore degree, octave, initialization, and internal staging state; no new serialization API is introduced. Different named instances have independent state.

## Evaluation and limitations

The source tests exercise native rendering against an independent exhaustive local lattice rather than copying the per-class search. Coverage includes signed octaves, scale/octave midpoints and adjacent f32 values, input clamp endpoints, NaN/infinities, one-note and microtonal scales, subnormal offsets, f32-output collapse, duplicate-after-rounding rejection, maximum 128-degree capacity, hysteresis equality and leaps, held reset, and exact snapshot continuation. The isolated packed-consumer gate additionally checks public TypeScript declarations, package resolution, actual native rendering at 44.1/48/96 kHz, zero scrubbed samples, and fixed memory.

Work per sample and captured graph size are linear in the fixed degree count. All candidates are evaluated; this is not a promise of automatic control-rate scheduling. No browser/hardware real-time acceptance, auditory approval, note-host delivery, adaptive tuning, or perceptual pitch quality is claimed. Test and audition artifacts remain CANDIDATE.

Scope source: [den catalog, group 5](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3). The numerical policy above is this implementation's explicit bounded interpretation of musical quantize, not a feature-equivalence claim about a referenced product.
