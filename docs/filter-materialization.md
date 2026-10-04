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

The fixture is in **this repository**, on the separate Delay FX PR #23 history;
it is not a file on this filter PR's main-based checkout. Fetch its exact commit
before looking for it:

- Repository: <https://github.com/yuichkun/den>
- Fixture commit: `7ef7ce670531b1230111f1d2c89302bfe44935b2`
- [Packed test at that commit](https://github.com/yuichkun/den/blob/7ef7ce670531b1230111f1d2c89302bfe44935b2/tests/delay-fx-packed.test.mjs)
- [Consumer directory at that commit](https://github.com/yuichkun/den/tree/7ef7ce670531b1230111f1d2c89302bfe44935b2/tests/delay-fx-consumer)
- Filter/probe revision: `ca3f18ee516cdf477260e7ab88ea0780c6bd049f`

Run this Bash recipe with Node 24, npm and Chromium's system dependencies
available. Optionally export `CHROMIUM_PATH` to an installed Chromium executable;
otherwise the recipe installs Playwright's pinned Chromium. The clone and all
worktrees are disposable. The candidate starts at the same fixture commit as the
baseline and receives **only** `src/filter.ts` from the specified filter revision.
Separate `TMPDIR` directories make both generated consumer paths unambiguous.

```bash
set -euo pipefail
repro_root=$(mktemp -d)
export npm_config_cache="$repro_root/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="$repro_root/playwright"
fixture_rev=7ef7ce670531b1230111f1d2c89302bfe44935b2
filter_rev=ca3f18ee516cdf477260e7ab88ea0780c6bd049f
git clone https://github.com/yuichkun/den.git "$repro_root/repo"
git -C "$repro_root/repo" fetch origin "$fixture_rev" "$filter_rev"
git -C "$repro_root/repo" worktree add --detach "$repro_root/baseline" "$fixture_rev"
git -C "$repro_root/repo" worktree add --detach "$repro_root/candidate" "$fixture_rev"
git -C "$repro_root/repo" worktree add --detach "$repro_root/tools" "$filter_rev"
git -C "$repro_root/repo" show "$filter_rev:src/filter.ts" > "$repro_root/candidate/src/filter.ts"
(
  cd "$repro_root/tools"
  npm ci
  if [ -z "${CHROMIUM_PATH:-}" ]; then
    npm exec -- playwright install chromium
  fi
)
mkdir -p "$repro_root/tmp/baseline" "$repro_root/tmp/candidate"
for variant in baseline candidate; do
  (
    cd "$repro_root/$variant"
    npm ci
    TMPDIR="$repro_root/tmp/$variant" node --test tests/delay-fx-packed.test.mjs
  ) > "$repro_root/$variant-packed.log" 2>&1
done
baseline_consumers=("$repro_root/tmp/baseline"/den-delay-fx-*)
candidate_consumers=("$repro_root/tmp/candidate"/den-delay-fx-*)
test "${#baseline_consumers[@]}" -eq 1
test "${#candidate_consumers[@]}" -eq 1
test -f "${baseline_consumers[0]}/package-lock.json"
test -f "${candidate_consumers[0]}/package-lock.json"
node "$repro_root/tools/tests/probes/filter-browser-timing.mjs"   "${baseline_consumers[0]}" "${candidate_consumers[0]}" "$repro_root/evidence"   > "$repro_root/timing.log" 2>&1
printf 'Retained reproduction directory: %s\n' "$repro_root"
```

A failed packed gate stops the recipe; inspect the corresponding `*-packed.log`
and retained `artifacts/delay-fx` directory rather than selecting a passing retry.
`evidence/browser-timing.json` includes every timing trial, WASM hash/size and raw
trace hash. Expect the same packed WASM sizes/hashes recorded below; timing values
are machine-dependent and must not be required to match the original numbers.

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
