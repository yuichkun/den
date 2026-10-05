# Initial candidate acceptance record

Scope: GEN-608's initial shared DSP, one MIDI instrument engine, three instrument
settings, one Delay FX engine and two effect settings. No new DSP, framework,
upstream unworklet change or registry publication is included in this integration.

## Decision boundary

This is an **initial usable CANDIDATE**. Source and behavior are based on
`196a1c3ef0e8eda9a007a2474c9d06f7f654acfa`. The final integration adds missing
public package subpaths, tests those imports, and makes the packed site build a
maintainable main-branch deployment while preserving the diagnostic pages.
Source under `src/`, the sound/FX values, dependencies and lockfiles are unchanged.
Independent review and exact-head CI are required before main merge. This file
does not claim the pending final merge or its CI has already completed.

The instrument runtime status remains **NOT_CLEARED**. Intermittent frame-clock
and output-underrun observations have not been attributed conclusively to den.
Per the owner's 2026-10-05 direction, den-specific reproducible defects warrant
investigation; open-ended upstream investigation is not a prerequisite for
continuing the initial candidate. This is not an all-device stability guarantee.
No test threshold is relaxed and no historical failure is converted into a pass.

## Acceptance criteria and evidence

| Scope | Implementation / evidence | Boundary |
| --- | --- | --- |
| Shared Envelope / LFO / filter | Independent numerical/time/phase/reset/response tests; existing shared implementations are used by both engines where applicable | 44.1/48/96 kHz offline; browser 48 kHz only |
| Voice / oscillator / instrument (GEN-617) | Voice allocation, legato/retrigger, steals, MIDI note end, per-voice envelopes/modulation, bypass/reset and same-schema restoration; `instrument.spec.ts`, `voice-policy.spec.ts`, isolated packed instrument tests | Construction capacity is not a proven real-time product limit |
| Reusable public API | `filter`, `voice-policy`, `delay-readhead`, and `instrument-example` now join the existing public subpaths; isolated consumers typecheck and render public imports, including the replacement oscillator/filter | No physical `node_modules/.../dist` import escape remains in the fixtures |
| Three sounds (GEN-619) | One engine with plain Bass / Percussion / Pad construction settings and complete native AudioParam maps; numerical fixtures and packed dry phrase/stress/snapshot tests | All raw audio remains CANDIDATE |
| Two FX settings (GEN-621) | Same Delay engine with Chorus and Rhythmic delay settings; independent delay-time/modulation/feedback/tempo/tail and bypass/reset fixtures | Moving-head pitch/click behavior follows the documented contract |
| Integrated sound/FX use | 4×3 packed numerical and browser matrix, all 22 initial sound parameters, stopped-only selectors, release/reset, cancellation/restart/context disposal; source identity assertions preserve raw candidate sounds | Fixed-input headroom measurements do not cover arbitrary edits or every device |
| Main deployment boundary | `build:site` combines identical packed packages; root integration, silent diagnostics and retained module audition; deployed-byte route smoke test | Existing Vercel access/header/project settings remain unchanged |
| Provenance | Per-run manifests connect source, dependencies, settings/parameters, MIDI/input, seed, rates, WAV/raw PCM, static waveform and verification | Human feedback and golden promotion are recorded separately |

The prior candidate's [exact-head CI 37279030893](https://github.com/yuichkun/den/actions/runs/37279030893)
passed 226 numerical, 10 packed and 2 realtime tests. That is prior-revision
machine evidence, not a substitute for this integration's exact-head run.
[Headroom evidence](sound-audition-headroom.md) records the 90-row matrix maximum
peak 0.368202865 (8.678 dB headroom) at Master 1 with zero nonfinite/clipped values.
The numerical assertions and full existing browser/lifecycle suite remain intact.

## Candidate listening feedback received

- 2026-10-05 15:55 JST: the owner replied “よさそう” to the three-sound WAV review.
  [Original feedback](https://escentier.slack.com/archives/C0C6LD2PH9S/p1791183335912499?thread_ts=1791107749.905829&cid=C0C6LD2PH9S)
- 2026-10-05 16:57 JST: the owner replied “問題なさそうありがとう” after the
  integrated preview with sound switching and combined FX.
  [Original feedback](https://escentier.slack.com/archives/C0C6LD2PH9S/p1791187049139809?thread_ts=1791107749.905829&cid=C0C6LD2PH9S)

These are positive candidate direction and device-use evaluations. Neither
request is awaiting a reply. They are not exact-source/audio-hash golden
approval, a general-release decision, or a claim of universal device stability.
No golden file is added or changed. Future sound changes require new evidence;
this integration does not silently transfer approval to different DSP/settings.

## Retained failures and limits

The original candidate `334d2db` had a local packed frame-clock failure (8/9
passed) and normal native/full realtime underrun failures. Later CI passes do
not erase those observations. The [PR26 historical record](https://github.com/yuichkun/den/pull/26)
retains the failed logs/archive hash and exact later runs. The
[instrument investigation](instrument-performance.md) and
[realtime audition record](realtime-audition.md) retain controls and limitations.
PR28 also retains local browser/timeout restrictions and the cancelled short-job
run separately from its eventual successful CI. Do not relabel those runs.

Generated test manifests describe that run's mechanical/physical-listening
limits; they do not negate the separately linked owner feedback. Hardware
loopback, broad device coverage and approved golden baselines are not claimed.
