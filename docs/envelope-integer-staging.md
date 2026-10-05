# Envelope integer expression staging

`envelope.tick` captures the previous `stage` and `remaining`, then temporarily
stores `active` and `count` in those existing integer slots. Reading each staged
value materializes its expression through unworklet's supported lexical read
capture. Old-history decisions use the captured old values. The original final
writes still run unconditionally, including reset. No declaration, snapshot
schema, floating-point intermediate store, or upstream dependency changes.

The subgraph exposes only `tick`. Its returned Nodes and caller-supplied control
Nodes capture memory reads before subsequent stores. Worklet snapshot requests
execute outside synchronous DSP execution. Direct concurrent inspection of raw
working memory in the middle of processing is not a compatibility guarantee.

## Regression evidence

- `envelope.spec.ts` and the closed-form ADSR and maximum-i32-count tests in
  `envelope-integer-staging.spec.ts` use independent numerical expectations.
- The other staging tests compare against a frozen copy of the pre-change
  implementation from `c65e2a8586eb0325cbccc3963af3764c7f15c926`. This is a
  differential baseline, not an independent numerical oracle. Do not update
  that fixture to match production.
- Tests cover 44.1/48/96 kHz, reset/retrigger/automation, tiny and extreme finite
  controls, complete state bytes, schema hash, bidirectional restore at five
  boundaries, continuous-vs-restored output, a cold-start negative control,
  independent instances, and delayed returned Nodes after caller state writes
  and a second tick. Multiple ticks are an adversarial capture-order probe,
  not a change to the once-per-sample usage contract.

Reproduce numerical regressions with:

```sh
npm ci
npm run check
npx vitest run tests/envelope.spec.ts tests/envelope-integer-staging.spec.ts
```

## Limited performance evidence

One fixed A/B/B/A diagnostic used main `c65e2a8` dependencies with the unchanged
instrument fixture from `baa4bd50` (instrument is not present on that main).
Chrome 151.0.7922.173, 48 kHz / 128 frames, four held A4 notes, identical controls,
five seconds warmup then six seconds measurement, no capture/recording/analyser.
All trials, including outliers and failures, were retained.

| Trial | Callback CPU median, us | Kernel CPU/callback, us | CPU overruns / callbacks | Output underruns |
| --- | ---: | ---: | ---: | ---: |
| Baseline A1 | 426 | 508.85 | 3/2249 | 0 |
| Candidate B1 | 322 | 446.85 | 11/2242 | 0 |
| Candidate B2 | 322 | 421.15 | 11/2187 | 6 |
| Baseline A2 | 434 | 577.72 | 10/2214 | 1 |

Median callback CPU decreased 24–26% in this workload. One-second medians were
415–438 us for baseline and 316–332 us for the candidate. Instrument WASM shrank
from 1043330 to 936570 bytes. These are workload-specific sustained-cost results,
not a universal performance guarantee or a runtime-gate pass.

Tail latency and output underruns remain unresolved: candidate maximum callback
CPU was 39105/7492 us. A separate existing realtime audition gate also failed
with two output underruns and was not retried. The prior done-only reuse proposal
had no sustained timing improvement and is not included. Initial verification
failures from missing browser installation and temporary disk exhaustion were
retained; after correcting those environment issues, the seven packed checks
passed. None of these results constitutes listening approval.
