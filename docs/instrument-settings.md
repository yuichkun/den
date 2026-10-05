# Bass / Percussion / Pad candidates (GEN-619)

These are three editable settings of `createInstrument`, using the existing
stock oscillator, filter, envelopes, LFO and voice policy. Every setting and
render is **CANDIDATE**. There is no approved golden or physical listening
acceptance. Runtime remains **NOT_CLEARED**; earlier frame gaps and underruns
recorded in [PR #26](https://github.com/yuichkun/den/pull/26) are not erased by a
successful run here. This change is stacked on that unmerged integration
candidate at `a1a6fd768f7f350f1072babefe00859f1330bfe6`, which includes the
unmerged instrument composition from PR #22 and main's envelope staging fix.

## Use the existing APIs

```ts
// processor.ts, compiled by @unworklet/unplugin as usual
import { createInstrument, bassConfig } from '@denaudio/den/instrument';
export const processor = createInstrument(bassConfig);
```

```ts
// Browser host, after the normal user-gesture audio startup
import { createNode } from '@unworklet/core';
import { bassParameters } from '@denaudio/den/instrument';
import processor from './processor.ts?worklet';
const node = await createNode(context, processor, { initial: bassParameters });
```

`percussionConfig` / `percussionParameters` and `padConfig` / `padParameters`
work the same way. All 22 native parameters are explicitly present in each
object; the complete values live in `src/instrument-settings.ts`. Edit those
ordinary values or the existing node AudioParams. There is no new preset,
serialization, MIDI, routing or loader framework, no new export-map entry and
no changed engine defaults. Browser compilation remains 48 kHz only on
unworklet 0.4.1; 44.1/96 kHz coverage is offline.

- Bass: one saw voice, last-held mono legato, gain .12, 5 ms amplitude attack,
  120 ms decay/release, .7 sustain. The filter rises briefly from 300 to 2400 Hz
  then settles near 455 Hz. Overlapping held notes preserve the transient;
  this does not implement portamento.
- Percussion: one retriggering sine voice, gain .16, 1 ms amplitude attack,
  220 ms decay to zero, 40 ms release. Pitch falls two octaves over 60 ms;
  note 36 is about 261.6 Hz at onset, settling to 65.4 Hz. Zero attack enters
  the first decay step, so the first pitch is slightly below that peak. It is
  tonal kick/tom-like percussion, with no noise generator.
- Pad: four saw voices, gain .045, 800 ms attack, 1.2 s decay to .7 sustain,
  2.4 s release. The shared .12 Hz LFO has an 8.333 s cycle, ±3-cent pitch
  depth, .08 tremolo depth and .2-octave filter depth. The dry output is dual
  mono; no stereo spread or unison is claimed.

All envelopes are linear. Release and retrigger begin at the previously emitted
level. Hard reset/retrigger/stealing can be discontinuous; this is not a
click-free claim. Sustain zero does not free a held MIDI identity. Send the
balanced note-offs supplied by the fixtures. There is no CC64 sustain.

Use native `snapshot()` / `restore()` for the **same processor/schema/rate**.
Construction changes are not portable preset migration. Restoring a new node
must not revive held notes. For a cold in-place restore, restore, emit `reset`,
render at least one quantum, then send fresh notes. Reset and MIDI in the same
quantum follow the reset-wins rule.

## Reproduction and evidence

```sh
npm ci
npm run check
npm test
# Focused packed candidate check with an installed Chromium:
CHROMIUM_PATH=/usr/bin/chromium node --test tests/sound-candidates-packed.test.mjs
```

The regular test command discovers both `tests/instrument-settings.spec.ts`
and `tests/sound-candidates-packed.test.mjs`. The latter packs den into a clean
locked consumer, checks the public import and TypeScript declarations, compiles
all three processors through Vite/unworklet, and runs the muted real Chromium
MIDI, parameter, release/reset/bypass and snapshot probes at 48 kHz. It does
not publish a site or change the integration preview.

`tests/sound-candidates-consumer/fixtures.mjs` fixes the FIFO MIDI inputs. The
Bass and Percussion phrases are 262144 frames at 48 kHz. Pad is 768000 frames
(16 seconds), with note-offs at 8, 9, 10 and 11 seconds. The last 2.6 seconds
cover silence following the final release. Lower and higher offline rates
preserve elapsed time by rounding each event to the nearest corresponding
128-frame quantum; expanded timestamps and frame lengths are retained.

Separate maximum-velocity inputs cover Bass legato and Percussion release
retrigger; Pad's maximum case uses four coherent A4 notes. Pad also has a
released-slot reuse / oldest-held steal case and an obsolete note-off that
must not release the replacement. These stress renders remain separate from
the three listening phrases.

Each run writes a new `artifacts/sound-candidates/<timestamp>/` directory,
preserving previous failures. Raw stereo float WAVs are unnormalized and dry;
static min/max waveforms have fixed ±1 scale. The manifest binds the source
commit/dirty bit and SHA-256 source hashes, tarball/lock hashes, dependency
versions, WASM size/hashes, verification results and candidate status. The
render evidence binds every construction option, parameter, expanded MIDI
array, rate, channels, seed (null), frame length, PCM/WAV hashes, exact-silence
boundary and peak/RMS/headroom/clipped/nonfinite measurements. Phrase renders
are repeated and their full PCM hashes must agree. Full-render and named-window
measurements are both retained.

Headroom is measured for these settings and inputs. The full-scale gate rejects
peak ≥1, nonfinite PCM, or scrubbed samples; it is also tested against deliberate
wrong signals. **The integration diagnostic's .8 analytic bound does not apply
to these saw/modulated settings.** No limiter or hidden normalization is added.
Arbitrary edits, resonances, pitches or voice counts are not covered by a
measurement for these fixed fixtures.

The independent numerical tests use literal candidate values, closed-form
linear envelope timing and replacement DC/frequency/cutoff probes. Existing
sine/static-biquad, saw-property, voice-policy and wrong-answer tests remain in
place. An audio-rate direct-form biquad is not treated as an exact dynamic SVF
reference. Headless signal checks are not device playback or listening approval.

## Listening and promotion boundary

Review the three canonical 48 kHz `*-phrase-48000.wav` files together, at a
comfortable user-controlled playback level:

1. Bass: low core and upper-register audibility; brief bright transient;
   held-note transition/return without restarting that transient.
2. Percussion: purposeful short pitch drop, velocity contrast, ringing/chirp
   quality; the burst intentionally truncates decay and retriggers in release.
3. Pad: smooth growth, clear chord and subtle slow motion; staggered independent
   long releases, with voice stealing assessed separately.

Any sound-affecting change requires regenerating the raw audio, waveform and
manifest. Only explicit human approval tied to those hashes, followed by a
separate reviewed change, can promote a candidate to a golden. This initial
change does not merge the integration candidate or clear its runtime gate.
