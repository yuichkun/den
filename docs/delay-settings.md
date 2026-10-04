# Chorus and rhythmic delay candidates

Two plain configuration/value objects use the existing `delayFx` engine. They add
no DSP, serializer, parameter registry, runtime, or UI. `chorusSettings` and
`rhythmicDelaySettings` live in `src/delay-settings.ts`; public exports are pending
integration. Values map directly to existing engine inputs / AudioParams. Supply
`sampleRate` from the processor context, and spread the config to select a different
fixed capacity before construction. Two seconds is a candidate allocation, not a
product limit. Tone mode and stereo phase are construction configuration.

| Setting | Time | Motion | Feedback / tone | Linear wet mix |
| --- | --- | --- | --- | --- |
| Chorus | 18 ms both channels | 0.65 Hz, ±3 ms; opposite phase | 0 / flat | 0.45 |
| Rhythmic delay | 120 BPM; dotted eighth left (375 ms), quarter right (500 ms) | disabled | 0.48 / 3200 Hz low-pass in feedback, Q=0.5 | 0.35 |

Chorus aims for slow stereo widening with audible pitch motion and dry/wet comb
coloration. Mono sources are explicitly duplicated; averaging the stereo output
can alter that coloration. Rhythmic delay aims for interleaved repeats that darken
with each pass. The first echo is unfiltered. Neither candidate has listening
approval. Changing source or controls uses the engine's existing inputs; changing
config requires reconstruction. Settings objects are compile-time readonly data,
not runtime-frozen objects or saved state.

## Acoustic behavior

Times and tempo jump immediately: a moving readhead can click and change pitch;
there is no crossfade or smoothing. Continuous chorus modulation deliberately
changes pitch. Rate zero holds phase; depth zero removes modulation. The 15–21 ms
chorus range fits the proposed capacity. At 30 BPM the rhythmic right tap reaches
the two-second boundary exactly. Requests beyond configured capacity or BPM
30–300 are rejected as unity dry, not silently changed into another rhythm.
Modulation is bounded to the engine limits, with clipping reported separately.

Stopping input preserves repeats. Bypass emits unity dry, blocks new input to
history, and lets the internal tail decay; unbypass can expose it. Reset clears
history/filter/phase immediately and may click. No output normalization or limiter
is applied. Use headroom when feeding correlated dry and delayed signals.

## Verification and reproduction

Run `npm ci`, `npm run check`, `npm test`, then
`node scripts/render-delay-settings.mjs` after building. Candidate plotting uses
Python with NumPy and Matplotlib (no package/lock change); its versions are recorded.
Generated files remain under ignored `artifacts/delay-settings/`. Run generation
from the exact reviewed commit; `sourceDirty` and hashes disclose provisional runs.

Dedicated tests cover both settings at 44.1/48/96 kHz with an unbounded written
sample timeline and independent direct-form bilinear biquad using `Math.tan`.
They verify mono duplication/opposite phase, zero-depth/same-phase collapse,
chorus quarter-cycle rate/depth with a closed-form ramp, rhythmic impulse positions
and integrated second-echo gain, tail, abrupt edits, capacity/tempo rejection,
modulation clipping, bypass/reset and silent-instance isolation. A shifted oracle
must fail. The 44.1-kHz left tap is fractional; the second repeat starts at twice
the earlier interpolation tap, not floor(twice the ideal delay).

Normal candidate renders use a 5e-6 absolute sample tolerance and exact status bits.
The 50-ms-depth stress case uses a separately calculated float-time rounding
budget: two time ULPs times sample rate, the input's maximum adjacent slope and
wet mix, divided by `(1-feedback)^2`, plus 2e-6. This accounts for the bounded sine
approximation and ideal sine straddling rounding ties; it is not a golden update.
The independent oracle rounds the 50-ms clamp constant to float32. Engine source
is unchanged. Packed settings are rendered in an isolated installed tarball at
all three offline rates. The existing engine browser gate remains 48 kHz only.

## Listening packet

Four short candidates: each setting's base sound and an edited version. Each has
raw float32 stereo input/output WAVs and a static waveform with the same time and
amplitude axes. The WAV encoder/decoder must round-trip samples exactly. Source
stops at two seconds; the rest exposes the tail. Edited clips change rate/depth
or tempo/feedback at 1.5 s, bypass at 3 s, unbypass at 3.5 s, and reset at 4.5 s.
The manifest contains every setting, sample-indexed edit, deterministic input
formula and actual input file, source/dependency hashes, rate/length, raw audio
hashes, waveform hashes, peak values and independent numerical errors. There is
no MIDI or random source. No loudness-matched derivative is included.

These are **initial reference CANDIDATES**, with no approved old audio or golden.
Human approval must name the source/settings/audio hashes in a separate record;
any sound-affecting update requires regeneration. Code checks alone do not approve
tone, widening, repeat balance, edit clicks or bypass/unbypass feel. Shared frontend
integration and public exports are separate. Proposed minimal root export:

```ts
export { chorusSettings, rhythmicDelaySettings } from './delay-settings.js';
export type { DelaySettings, DelaySettingsValues } from './delay-settings.js';
```

The checked-in `delay-settings-candidate.json` is the small provenance manifest
for source commit `d542ebe3b4bfd7fc51222519be810819cf47cac9`. Audio and images are
excluded from Git. Regenerate them with the command above into `artifacts/`, the
repository's existing CI artifact-upload path. The recorded audio remains
CANDIDATE, even when the mechanical checks pass. A documentation-only commit does
not invalidate the recorded source/file hashes.

For focused review, after `npm ci && npm run build` run:

```sh
npm run check
npx vitest run tests/delay-settings.spec.ts
node --test tests/delay-settings-packed.test.mjs
```

The dedicated packed check installs the tarball into a separate locked consumer
and tests both settings at 44.1/48/96 kHz. Its package and verification files are
also written under `artifacts/delay-settings/`. Candidate audio generation is an
explicit local step; the current workflow does not automatically run the plotting
script. Publishing the listening packet through CI requires the integration
owner's existing artifact workflow; no preview/deployment settings are changed here.
