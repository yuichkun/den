# Filter coefficient materialization

The low-pass expression repeats its Taylor-polynomial coefficient when unworklet
0.4.1 lowers the expression tree. Materializing only `g` reduces emitted WASM and
first-callback lazy compilation without changing coefficient arithmetic.

`band.read()` and `low.read()` first capture the old integrator values into WASM
locals. The existing `band` slot then stages `g`; a subsequent read captures that
coefficient, and the original final integrator writes replace the staged value
before `tick` returns. There are no added declarations, persistent/transient
slots, sample delays, changed coefficients, or reordered final integrator updates.
Snapshot schema, slot names/types, and saved bytes remain identical. The method
still runs exactly once per sample per instance, on the existing audio thread.

Only the bounded positive coefficient is staged. Across the supported sample-rate
and cutoff range, `g` exceeds 3e-4, far above the pinned runtime's 1e-30 state-write
flush threshold. Audio intermediates `v1`/`v2` must not be materialized via new
scalar states: doing so introduces an extra flush before a caller can amplify the
returned sample. For example, at 48 kHz, cutoff 1000 Hz, Q 0.707, input 1e-30,
and a finite post-filter gain of 1e30, the original output is nonzero whereas that
alternative becomes zero. Adding transient declarations also changes the schema
hash, even when saved slots appear unchanged.

## Verification

`tests/filter-materialization.spec.ts` compares against the frozen pre-change
implementation from main `e12adc5`; this is a compatibility reference, not a new
correctness oracle. The existing independent biquad/response tests remain intact.
The compatibility tests cover:

- 8/44.1/48/96/192 kHz, cutoff/Q clamps and per-sample modulation;
- eight input levels from 1 to 1e-44, plus finite post-filter gains;
- resets around quantum boundaries, isolated instances and same-sample cascades;
- identical schema, saved bytes, and bidirectional snapshot continuation;
- the amplified tiny-constant counterexample and a 262144-sample resonant tail,
  preserving the existing flush behavior including any tiny residual.

The separate Delay FX fixture at `7ef7ce6` was packed with each filter version.
All four output/status channels and complete snapshot bytes matched across 18
cases: 44.1/48/96 kHz × low/high/dynamic tone × modulation off/on, 8192 samples
per case, including varying times/mix, bypass, reset and rejected sync requests.
Its independent 31 numerical tests and corrected 48-kHz packed browser gate also
passed. Offline rate coverage remains distinct from 48-kHz browser coverage.

## Timing reproduction

Build and install the existing isolated Delay FX consumer twice using
`tests/delay-fx-packed.test.mjs` at `7ef7ce6`: once unchanged and once with only
this filter patch. Keep both disposable consumer directories. Then run:

```sh
CHROMIUM_PATH=/path/to/chromium node tests/probes/filter-browser-timing.mjs \
  /path/to/baseline-consumer /path/to/candidate-consumer /path/to/evidence
```

The probe appends a recorder-free entry to the disposable consumer pages, rebuilds
with the existing plugin, and alternates four fresh-browser trials per variant.
Each trial runs for 12 seconds at 48 kHz. It retains every trace and reports the
first callback separately from all later callbacks; no initial samples or slow
trials are removed. CPU profiling is disabled. Chromium tracing can still affect
timing, and thread-CPU durations occasionally exceeding wall time are explicitly
flagged as clock/accounting anomalies. No hardware-output deadline guarantee or
listening approval follows from these diagnostics.

## Observed results

On Node 24.19.0 / Chromium 151.0.7922.173, with all eight trials retained:

| Measurement | Original | Coefficient-only staging |
| --- | --- | --- |
| Packed Delay WASM bytes | 45,935 | 24,707 |
| First callback wall time, four runs | 2.815–6.584 ms | 1.659–1.900 ms |
| First callback thread CPU, four runs | 2.743–2.948 ms | 1.656–1.897 ms |
| Later callback wall mean, range across runs | 0.0956–0.0990 ms | 0.0941–0.0999 ms |
| Later callback wall p99, range across runs | 0.172–0.227 ms | 0.176–0.194 ms |

The original first callback contains synchronous `wasm.CompileLazy`; the smaller
artifact reduces the observed startup cost. These results do not establish a
hot-path speedup or a universal deadline guarantee. The separate direct-driver
benchmark measured means of 0.0784 ms (original) and 0.0849 ms (candidate), excluding
browser scheduling and copy overhead; it likewise does not support a hot-speedup
claim. Full per-trial timings, settings, WASM hashes, outliers and trace hashes are
in [filter-materialization-results.json](filter-materialization-results.json).
