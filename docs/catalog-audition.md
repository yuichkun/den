# Catalog A/B audition

`npm run build:site` stages `/catalog.html` as the A/B listening page beside
the catalog home and `/playground.html` instrument/FX page. The two audio
consumers install identical packed den bytes with locked dependencies. The
original five settings are unchanged. Developer diagnostics are test-only and
are not copied into the public output.

`npm run build:catalog` builds this page alone at `/`; only the combined staging
step adds sibling navigation. The catalog home links a material with
`?example=glass|hit|grain|echo`; a recognized value selects that material, while
an unknown value uses Glass dyad. No deep link starts audio.

## Four candidate materials

The page imports the already reviewed `/musical-examples` processors, complete
A/B parameter maps and original asset builders without rewriting or normalizing
them. See [musical examples](musical-examples.md) for independent three-rate
pitch, envelope, tail, headroom, repeat and snapshot evidence.

- Glass dyad: two independently held 220/330 Hz wavetable voices, original
  three-frame cycle bank, soft-glass and brighter-harmonic maps.
- FM/modal hit: fixed 220 Hz FM voice with three resonant modes. Gate rise
  strikes once; a new strike clears the previous tail.
- Grain cloud: two seeded grains over original 4096-frame PCM, forward/reverse
  maps. Release stops new grains and lets current windows finish.
- Shaped echo: soft ADAA, Q0.5 low-pass and stereo repeats. This page supplies a
  native 220 Hz sine at amplitude 0.25 with a 10 ms gain time constant. This
  explicit audition source is separate from the effect's unchanged settings.

The visible master ranges from 0 to 1 and defaults to **1.00×**. There is no
hidden additional attenuation, normalization, limiter or per-example leveling.
Start with low device volume. Stereo waveforms use a fixed −1..+1 scale; the
visible peak is an observed analyser window, not proof of all-frame headroom or
all-device deadline clearance. The browser is deliberately restricted to 48 kHz.

## Interaction and cleanup

No AudioContext is constructed on page load. Start creates a fresh context and
native node with all gates off. Asset-backed candidates send the original PCM
through the existing native event, then inspect native snapshot length and
buffer-head values before enabling the play controls. The displayed SHA256
identifies the complete submitted asset; the receipt check itself checks loaded
length and the inspected head, not a full buffer hash. Snapshot acknowledgement
has a 10-second bound and is cancelled immediately by Stop.

Select materials and A/B maps while stopped. Pointer capture supports separate
fingers. Global A/S/Space shortcuts apply outside interactive controls. Focus a
play button and hold Enter/Space to play it; assistive/virtual click activation
holds for 180 ms and releases. Focused Stop, Clear, Release, sliders and links
keep their native keyboard behavior. Blur releases held intents.

Release drops gates and leaves tails. Clear drops gates and source excitation,
holds the native reset for 40 ms, and leaves the context ready. Stop releases,
fades the master for 20 ms and disposes/closes audio. Visibility loss and
navigation close immediately. Generation/cancellation checks keep late resume,
compilation or preload completion from reviving an old session. No microphone,
external MIDI, loader, parameter, snapshot or routing framework is added.

## Provenance and verification boundary

The build records packed-package integrity plus the Git commit and dirty state
when the checkout is available. A Vercel build without Git may use the documented
`VERCEL_GIT_COMMIT_SHA` system value; otherwise it explicitly says unavailable.
No project access or environment settings are changed, and no other environment
values are exposed. Browser assets display CANDIDATE and Runtime NOT_CLEARED.

`tests/catalog-audition.test.mjs` serves the actual combined staged bytes. The
hosted browser gate must exercise all eight A/B selections, native asset receipt,
actual stereo unity/half-gain residuals, finite/headroom windows, release/tail,
clear/stop and route preservation. The independent lifecycle helper observes
native contexts/worklets and introduces resume/WASM/snapshot barriers; it checks
cancellation, retry, keyboard/touch behavior, fatal errors and navigation. Mobile
and desktop screenshots and a source/package manifest are retained. The earlier
offline tests remain the full-frame numerical/headroom/continuation evidence.

Local compilation/staging is not a browser pass. Hosted exact-head CI and review
must pass before integration. No new human listening approval or golden
promotion is inferred from automated checks. Historical intermittent runtime
failures remain open.
