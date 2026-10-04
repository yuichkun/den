# Instrument performance investigation

Status: incomplete. Numerical continuity is not a real-time readiness verdict.
Baseline source is `9a75f9c07e89d0dd77d598bf3e35ee51af1eb26e`, unworklet
0.4.1, Chromium 151.0.7922.173, 48000 Hz and 128-frame quanta. All audio is
CANDIDATE. No hardware loopback or listening approval is claimed.

Manual reproductions are in `tests/instrument-performance/`. Each invocation
creates a separate directory under `artifacts/instrument-investigation/` with
source copies/hashes, WASM, raw samples, per-block timings and a manifest.
Preserve all trials, outliers and failed preflights; do not retry in place.

## Cost controls

The direct Node 24 trials retain wall time and **process-wide** CPU, which is
not render-thread CPU. Chrome trace `dur` and `tdur` measure the enclosing
Render event, including graph/observer work. They are not instrument-only cost.
The nominal quantum budget is 2666.667 microseconds.

| Configuration | Node median, microseconds | Chrome median, microseconds |
| --- | ---: | ---: |
| 1 voice capacity | 228 | 110–113 |
| 4 voice capacity, four sounding | 1047–1049 | 351–357 |
| 4 voice capacity, none sounding | 1064–1072 | 352–364 |
| 16 voice capacity | 33053–33602 | 1507–1521 |

These are construction capacities, not product limits. Inactive slots currently
execute DSP. The dynamic voice-policy-only control costs approximately 6, 7 and
13 microseconds at capacities 4, 8 and 16; it does not explain whole-engine cost.
Node and Chrome differ substantially. Yielding between blocks did not resolve
Node's 16-voice cost, so tier installation is not an established explanation.

Materializing the instrument's combined modulation depths and final stereo mix
reduces WASM from 1083626 to 1049832 bytes and Node median from roughly
1015–1063 to 570–659 microseconds. Three captured scenarios are bit-identical,
including modulation, sample-varying cutoff/Q and release. Chrome medians remain
359–366 microseconds versus baseline 358–360; this is **not** a demonstrated
browser deadline fix. The candidate remains detached from production source.

## Frame metadata counterexample

Run `2026-10-04T13-37-51.511Z-browser`, trial `trial0-four-active4-poll1`,
reproduces currentFrame values 131840, 131840, 132096. Entry and exit values
agree within each callback; currentTime repeats too. All input blocks contain
128 samples. The complete raw stream matches the independent 440 Hz sinusoid
with maximum residual 6.1391e-9.

At anomalous quantum 820, normal continuation has maximum residual 5.4479e-9.
An independently predicted repeated or skipped 128-frame block instead differs
by 0.06946. This reproduction shows a frame-clock metadata anomaly without
duplicated/skipped audio in the captured graph. It does not establish hardware
output continuity, or retroactively explain the old CI failure whose raw data
was not retained. CI used Chromium 148; this reproduction uses Chromium 151.

The packed test now writes raw/metrics/manifest before asserting frame gaps.
The CI integration owner should also upload failure artifacts (`always()`),
because success-only upload loses the evidence needed to diagnose failures.

## Underrun controls without trace or observation worklet

Run `2026-10-04T13-48-23.859Z-browser` uses native Analyser capture of the final
32768 samples only. This is not full-stream continuity evidence. Chrome tracing
and the capture AudioWorklet are both absent. Native playbackStats counters are
sampled at startup, after one audio second, and at the end; differences below
exclude startup. All three trials per condition are retained.

| Condition | Steady underrun events, trials 0 / 1 / 2 | Duration, seconds |
| --- | --- | --- |
| Native AudioBufferSource | 0 / 0 / 0 | 0 / 0 / 0 |
| Four-voice instrument | 42 / 0 / 81 | 0.42084 / 0 / 0.81162 |

These browser-internal counters are not hardware-loopback measurements. They
nevertheless prevent dismissing all observed failures as tracing or capture-AW
overhead. No-trace trials have no per-quantum duration measurement; an empty
trace must not be interpreted as zero deadline overruns. Aggregate CDP process
CPU is retained separately and includes initialization and other browser work.

Further work must correlate full raw capture, frame metadata, playbackStats and
trace/no-trace conditions, then validate any instrument change at the same head.
Shared filter changes are outside this investigation's production ownership.

Full raw, no-trace follow-up `2026-10-04T13-50-17.498Z-browser` retains one trial
of each setting: native without timestamp polling, native with polling, four-slot
instrument silent, and four-slot instrument sounding. Post-warmup underrun
counts are respectively 12, 2, 101 and 61; durations are 0.12024, 0.02004,
1.01202 and 0.61122 seconds. Native sample counters have zero breaks. Sounding
instrument PCM residual is 6.145e-9. The silent instrument has two frame metadata
anomalies; silence cannot establish whether audio frames were lost. These controls
show both observation overhead and instrument-associated failures. Full raw graph
continuity and browser output underrun counters describe different boundaries.

## Instrument-only depth materialization

`2026-10-04T13-56-04.747Z-owned` compares the original source, depth-only
materialization, and the earlier depth-plus-final-mix candidate. The latter is
rejected: a valid `gain=1e-35` output becomes zero at the new state write. The
regression checks its independently expected nonzero value and downstream gain.
The upstream f32/f64 state and buffer stores flush magnitudes below 1e-30;
audio output stores do not. No upstream source was changed.

Only combined pitch/cutoff exponents are cached in the selected change. Such
exponents below 1e-30 already produce an exactly-one rounded octave ratio in
the existing polynomial. The stored expression is already f32, so other finite
values gain no extra rounding. Final mix remains an expression. Cache entries
are overwritten before every read, including reset and restoration.

All 42 combinations of 1/4 voices, 44100/48000/96000 Hz and seven scenarios
(normal, dynamic, reset, cold-node restore, custom parts, tiny output, tiny
depth) are bit-identical for the depth-only variant, with zero scrubbed samples.
The six tiny-output comparisons reject the final-mix variant. Raw PCM and
source copies are preserved for each variant, not just passing cases.

| Capacity | Variant | WASM bytes | First process, ms | Hot median, µs |
| --- | --- | ---: | ---: | ---: |
| 1 | baseline | 813236 | 66.28 | 231.20 |
| 1 | depth cache | 804852 | 60.43 | 151.61 |
| 4 | baseline | 1083626 | 120.00 | 1203.85 |
| 4 | depth cache | 1050090 | 124.10 | 676.40 |

These are single Node timing trials (2500 quanta, hot after 500), with inactive
voices, held capacity 128 and zero-filled native driver parameter buffers. Every block's wall/process
CPU is retained. Compile times are 860/858 ms for 1 voice and 962/1012 ms for
4 voices; instantiate times are 4.21/3.24 and 5.89/5.56 ms. The first process
includes lazy compilation. No uniform cold-time improvement is established.

Chrome no-trace comparison `2026-10-04T13-58-07.908Z-browser` uses two full-raw
12-second trials per variant/capacity, all with held capacity 128. All raw
sinusoid checks pass and frame metadata gaps are zero. The source snapshots
contain the exact detached baseline/candidate; production changes during the
run do not affect those compiled variants.

| Capacity / variant | createNode, ms (two trials) | Underrun events | Underrun seconds |
| --- | --- | --- | --- |
| 1 baseline | 43.49 / 42.38 | 17 / 25 | 0.17034 / 0.25050 |
| 1 depth cache | 35.48 / 37.69 | 20 / 40 | 0.20040 / 0.40080 |
| 4 baseline | 53.42 / 63.84 | 53 / 102 | 0.53106 / 1.02204 |
| 4 depth cache | 43.96 / 40.62 | 69 / 71 | 0.69138 / 0.71142 |

Average reported latency is 31.29 ms in all eight trials. createNode includes
module/node setup, not the first audio process. Its reduction is not proof of a
deadline improvement. These trials do **not** demonstrate an underrun fix.
Although counters are subtracted at the fixture's warm marker, playbackStats
`totalDuration` is only 0.002666 seconds there. Unlike the unobserved controls,
these full-capture deltas can include startup and must not be labeled strictly
steady-state counts. Trace-based per-quantum hot measurements remain separate.

Trace follow-up `2026-10-04T14-01-35.795Z-browser` (one trial each) gives:

| Capacity / variant | Hot wall median / p99, µs | Wall overruns | CPU overruns | playbackStats underruns |
| --- | --- | ---: | ---: | ---: |
| 1 baseline | 111 / 898 | 7 | 8 | 16 |
| 1 depth cache | 109 / 537 | 3 | 3 | 41 |
| 4 baseline | 354 / 2189 | 23 | 24 | 53 |
| 4 depth cache | 356 / 1910 | 13 | 14 | 165 |

All raw continuity checks pass; frame gaps are zero. The four-voice candidate
still has a 39288 µs maximum hot Render event. Median CPU is 103/101 µs for
one voice and 346/347 µs for four. Neither the smaller tail count in this single
trace nor the successful PCM checks justify real-time readiness. Browser median
cost is unchanged and underruns persist. The change is a Node execution and
generated-size improvement, not a demonstrated browser performance fix.

Raw-preserving Node repeat `2026-10-04T14-03-30.314Z-owned-timing` records
2500 inactive quanta per variant, PCM and every CPU/wall sample. Hot medians
are 245/152 µs (one voice) and 1129/617 µs (four), baseline/cache. First-block
times are 79/91 and 137/112 ms. The original timing-only subtrial retained
timings but no PCM; it remains preserved as such rather than relabeled complete.

To reproduce the selected comparison, run `node tests/instrument-performance/owned.mjs`,
then supply its evidence directory as `PROPOSALS_DIR` to `benchmark-owned.mjs`
or to `browser.mjs` with `CONTROL_MODE=owned`. `NO_TRACE=1` separates playback
counters from tracing, `TRIALS` controls repetitions, and `CHROMIUM_PATH` selects
the browser executable. Original artifacts and source snapshots are immutable;
new invocations produce new timestamped directories.
