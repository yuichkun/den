# unworklet compatibility findings

The current checks use registry-installed **0.6.0** packages and the checked-in
locks. The initial 0.4.1 findings are retained below as historical context; fixes
are checked against their correct behavior rather than preserving upstream bugs.
No unworklet source or package internals are patched.

| Issue | 0.4.1 observation | 0.6.0 regression check and remaining constraint |
| --- | --- | --- |
| [#78](https://github.com/yuichkun/unworklet/issues/78) | A pre-render snapshot stored gain 0 instead of initial 0.5; suspended edits stored the last rendered value. | Real Chromium snapshots retain initial 0.5 and a suspended edit to 0.25. Rendering verifies 0.5 → 0.25 → restored 0.5 at 44.1/48/96 kHz. |
| [#79](https://github.com/yuichkun/unworklet/issues/79) | Restoring f32(1) into a same-name i32 slot yielded the reinterpreted bits 1065353216. | The incompatible slot is skipped and keeps its initial i32 value 7. den promises identical-schema/rate continuation; deliberate type changes still need a reviewed migration. |
| [#96](https://github.com/yuichkun/unworklet/issues/96) | duration=896/48000 executed 8 blocks instead of 7. | Exact 896- and 256-sample durations execute 7 and 2 default quanta. |
| [#98](https://github.com/yuichkun/unworklet/issues/98) | Unity DC measured 6.021 dB. | Unity DC measures 0 dB; the helper rejects the doubled-gain expectation. Direct sample comparisons remain independent checks. |
| [#104](https://github.com/yuichkun/unworklet/issues/104) | A default config `{name:'default'}` swallowed `{name:'x'}`, producing 7 instead of 1. | **Still reproduced.** Required config plus a separate explicit instance name renders 1; den continues to use this form. |
| [#106](https://github.com/yuichkun/unworklet/issues/106) | A lang type import under TS 5.9.3 ESNext failed with Volar TS2416. | Both ES2023 and ESNext pass strict checking with `skipLibCheck:false`. The consumer keeps ES2023 without a declaration shim. |

The 0.5.0 and 0.6.0 [upstream changelog](https://github.com/yuichkun/unworklet/blob/v0.6.0/CHANGELOG.md)
describes the snapshot, duration, gain, declaration and compilation changes.
`tests/dependency.spec.ts` and the packed browser entry test independently check
the paths above. `expectAudioMatches` accepts an independently calculated
one-sample memory and rejects an intentionally incorrect answer. No audio golden
is regenerated or approved by these tests.

Reviewed but not independently reproduced here: #95 (snapshot matcher name reuse)
and #97 (integer WAV golden scale). This gate uses float WAV output and direct
sample assertions. Build/HMR reuse (#100/#101/#102), arbitrary schema migrations,
SIMD, DevTools and other APIs remain outside this fixture's coverage.

## Browser sample rate and render quantum

The packed entry consumer renders at **44100, 48000 and 96000 Hz** through the
public `?worklet` import and `createNode`. At non-default rates, unworklet 0.6.0
compiles in its generated Web Worker for the actual AudioContext. The test checks
real output, live gain changes and snapshot restoration at each rate, and records
the actual rate and quantum in the browser evidence. Offline sample-rate coverage
is recorded separately; it is not substituted for browser evidence.

A processor compiled directly, including the playground's compiler worker, must
receive `{ sampleRate: context.sampleRate, renderQuantumSize:
context.renderQuantumSize ?? 128 }`. Its runtime metadata and schema hash must
come from that compile result. The playground browser gate separately checks
44.1/48/96 kHz with 32/128/256-sample quanta. Fixed-length DSP buffer traversal uses
`forIndex`; FFT lengths and sample-based hop periods are not render quanta.
See the [spectral contract](spectral.md) for snapshot dispatch behavior.

These tests establish the listed contexts and operations, not arbitrary device
performance or realtime deadline clearance. Cross-rate snapshot continuation and
human sound approval remain outside this gate.

## Tooling security

Vite remains pinned to **7.3.6** in the package and isolated consumers. The former
7.3.1 pin was affected by
[GHSA-p9ff-h696-f583](https://github.com/vitejs/vite/security/advisories/GHSA-p9ff-h696-f583)
and other reported advisories. The gate serves a production preview on
`127.0.0.1`; it does not expose a development server to the network. Locks retain
the patched esbuild dependency. Root and consumer audit results are checked after
installation.
