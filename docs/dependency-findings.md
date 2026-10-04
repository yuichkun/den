# unworklet 0.4.1 findings

The upstream reports #68–106 were read as reports, not assumed verified. These
checks use registry-installed 0.4.1 packages and the checked-in dependency locks.
No unworklet repository or dependency source was modified.

| Issue | Independently observed here | Smallest den-local constraint |
| --- | --- | --- |
| [#78](https://github.com/yuichkun/unworklet/issues/78) | Real Chromium: gain initialized 0.5 but pre-render snapshot stores 0; editing to 0.25 while suspended still stores last-rendered 0.5. | Save after stable parameter values have rendered. Browser test verifies 0.5 → 0.25 → restored 0.5 in actual output. Suspended preset editing remains unsupported. |
| [#79](https://github.com/yuichkun/unworklet/issues/79) | Restoring f32(1) into same-name i32 state yields 1065353216. | Gate accepts identical schema/rate only. Do not expose incompatible saved presets without reviewed migration tests. No den serializer added. |
| [#96](https://github.com/yuichkun/unworklet/issues/96) | duration=896/48000 executes 8 blocks instead of 7. | Fixed gate durations 128/sampleRate and 256/sampleRate are verified by lengths/state; do not infer arbitrary durations are safe. |
| [#98](https://github.com/yuichkun/unworklet/issues/98) | Unity DC fails the frequency-gain helper with 6.021 dB. | Direct independent sample comparisons; no FFT is needed for this gate. |
| [#104](https://github.com/yuichkun/unworklet/issues/104) | Default config `{name:'default'}` swallows `{name:'x'}`, output 7 rather than 1. | Required config parameter plus explicit separate instance name renders 1. Used by gate and consumer. |
| [#106](https://github.com/yuichkun/unworklet/issues/106) | Pure lang type import under TS 5.9.3 ESNext fails with Volar TS2416; ES2023 has zero diagnostics. | ES2023, strict=true, skipLibCheck=false. No type shim or blanket declaration skipping. |

The pinned dependency reproduction assertions intentionally capture known wrong
behavior. On dependency upgrade, investigate changes and replace them with correct
regression expectations; do not preserve upstream bugs as product requirements.

`expectAudioMatches` is exercised against an independently calculated one-sample
memory and against an intentionally incorrect answer. The helper passes the former
and rejects the latter. No audio snapshot matcher or golden update is used.

Reviewed but **not reproduced** here: #95 (snapshot matcher name reuse), #97
(integer WAV golden scale). The gate uses no approved golden; its WAVs use the
existing float encoder, and numerical assertions inspect raw samples. Before future
golden adoption, test these helper paths rather than assuming approval machinery.
#100/#101/#102 concern build/HMR reuse; the gate uses a new build process and a new
AudioContext, and does not claim HMR/repeated in-process build correctness.
`.uwk` lowering, SIMD, MIDI dispatch, DevTools, arbitrary schema migration, and the
other reported APIs are outside this fixture; their reports are not cleared by
this PR. Later lanes must inspect and reproduce the bugs relevant to their APIs.
