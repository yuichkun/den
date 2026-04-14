# Contributing to `den`

Thanks for helping build the de facto Web DSP library. Read this all the way through before opening a PR that adds an effect.

## 1. Ways to contribute

- **Add an effect** — use the [Add effect](../../issues/new?template=add-effect.yml) issue template. A maintainer or worker AI picks it up and follows the 8-step workflow in §3.
- **Report a bug** — open a regular issue with a minimal reproduction (a Vercel preview URL of the failing PR is ideal).
- **Improve infrastructure** — scaffolder, test harness, catalog UX, CI. File an issue first to scope before opening a PR.

All package management is done through Vite+ (`vp`). **Never invoke `npm` / `pnpm` / `yarn` / `npx` directly** — this includes shell commands, README examples, CI scripts, and test-plan commands. Use `vp install`, `vp add`, `vp run <script>`, `vp check`, `vp test`. See https://viteplus.dev for the full command map.

## 2. Reference source allow-list

Every effect must derive from a vetted reference — no invented DSP. The authoritative allow-list is shipped by Sub F as `LICENSE-THIRDPARTY`; until then, the interim rule is:

- **Auto-approved references** (MIT / Apache-2.0 / BSD-compatible, already audio-community vetted):
  - FunDSP (MIT/Apache-2.0) — https://github.com/SamiPerttu/fundsp
  - Airwindows (MIT) — https://github.com/airwindows/airwindows
  - dasp (MIT/Apache-2.0) — https://github.com/RustAudio/dasp
  - Julius O. Smith CCRMA pages (formulas only, re-implement in Rust) — https://ccrma.stanford.edu/~jos/
  - RBJ Audio EQ Cookbook (formulas only) — https://www.w3.org/TR/audio-eq-cookbook/
  - DAFX / Zölzer et al. (textbook formulas)
- **Any other reference**: confirm with a maintainer (comment on your Add-effect issue) before implementation starts. GPL-only code and closed-source commercial code are out.

Sub F will replace this section with a cross-link to `LICENSE-THIRDPARTY` and a tiered (A/B/C) classification.

## 3. 8-step workflow for adding an effect

Assumes an `Add-effect` issue already exists. Links to artifacts in this repo, not upstream.

1. **Verify the reference** — open the source, confirm license, copy the specific formula/snippet into your local notes.
2. **Scaffold**:

   ```bash
   vp run gen:effect <effect-name>                    # naive PascalCase
   vp run gen:effect <effect-name> --class <ClassName> # for acronymed effects
   ```

   Commit now (empty stubs; all tiers fail) as `chore(<effect>): scaffold`. The freshly scaffolded tree will NOT pass `vp check` yet — the new Kernel ID and class export are not wired until steps 4 and 5. That is expected; `vp check` goes green once the effect is implemented end-to-end.

3. **Rust kernel** (`crates/den-core/src/effects/<snake>.rs`):
   - Fill the `State` struct fields (use `f64` for smoothed or recursive values — see `gain.rs` for the canonical pattern).
   - Implement `den_<snake>_init` and `den_<snake>_process`.
   - Replace the placeholder test with Tier1 unit tests: identity-like, one known-output case from the reference, one edge case from the issue.
   - `cargo test -p den-core effects::<snake>` must pass before continuing.
4. **Worklet dispatch** (`packages/worklet/src/processor.ts`):
   - Add the kernel ID to the `type Kernel = "passthrough" | "gain" | ...` union at the top of the file. The scaffolder's dispatch `case` stub fails typechecking until you do this.
   - Complete the `case "<kebab>":` block added by the scaffolder.
   - Allocate any state / param-scratch pointers in the constructor (mirror the `gain` branch).
   - Extend the `den_<snake>_process` signature on the untyped exports type hint.
5. **TS class** (`packages/effects/src/<kebab>.ts`):
   - Declare one `readonly AudioParam` per parameter.
   - Populate `parameterData` and `processorOptions`. Match param names exactly with `parameterDescriptors` in `processor.ts`.
   - If the kernel has a seedable smoother, mirror `Gain`'s clamp + `__denInitial*` forward so the first quantum starts at the user value.
6. **scipy reference** (`scripts/gen-golden/effects.py`):
   - Write the reference implementation. Textbook-simple, no optimization. Use `f64` throughout and cast to `f32` only for the output array.
   - Replace the scaffolder's placeholder `REGISTRY["<effect>"]` with a real `Effect(...)` entry using the presets from the issue.
7. **Goldens + tests**:
   ```bash
   vp run gen-golden <effect-name>
   git add packages/test-utils/golden/<effect-name>
   ```
   Replace the Tier3a `test.fixme(...)` placeholder in `packages/examples/tests/<kebab>.spec.ts` with a real spec modeled after `gain.spec.ts`.
8. **Tests + Vercel review**:
   ```bash
   vp run test          # Tier2 + Tier3a
   ```
   Open a PR linked to the Add-effect issue. Vercel's bot posts a preview URL. A reviewer opens `#/<kebab>`, plays through, and approves.

## 4. Common pitfalls

- **Non-deterministic kernel** — `#[no_std]` means no `rand`. Any randomness must be seeded from the caller. State struct is the only place to hold it.
- **Allocation in `process()`** — forbidden. All buffers are pre-allocated in the processor constructor. Use WASM scratch pointers.
- **AudioParam length handling** — Web Audio passes length 1 (k-rate or a-rate without scheduled events) or 128 (sample-accurate a-rate); the worklet path never hands you zero. The `n_<param>_values == 0` branches in scaffolded kernels are release-mode safety nets, not a code path to rely on.
- **Smoothing state divergence** — if your effect has smoothed params, golden generation must use the same smoothing arithmetic at `f64` with the same `init` value. Mismatch surfaces as a Tier2 null around -40 dBFS. See `gain.rs` + `gain_process` in `effects.py` for the canonical pattern.
- **Denormals** — feedback-y effects (filters, reverbs) can drift into denormals, tanking CPU on some platforms. Flush-to-zero or hand-rolled denormal filters are per-effect additions when the reference calls for them.
- **Catalog A/B not working** — each effect page creates its own `AudioContext` via `renderEffectPage`. Don't share one across pages; the helper handles teardown on `signal.abort`.
- **PascalCase acronyms** — the scaffolder's default kebab→Pascal split produces `Eq3Band` / `FftWindow` / `Lfo`. Pass `--class EQ3Band` (or the canonical casing) to the scaffolder, and fill the "Class name override" field on the issue form, whenever the effect name contains a common audio acronym (EQ, FFT, LFO, FIR, IIR, FM, AM, HP, LP, BP, DC, RMS, …).
- **Allocation/dealloc size mismatch** — `den_alloc(n)` allocates with `Layout::from_size_align(n, 16)`. The matching `den_dealloc(ptr, n)` MUST pass the exact same `n`. Off-by-one or rounding silently leaks the allocation. Always store the allocation size alongside the pointer (see `paramScratchSize` in `processor.ts`).
- **State pointer ordering** — every kernel that holds state MUST take `state: *mut <Effect>State` as the first argument, then audio buffer pointers, then param `(ptr, len)` pairs. The processor.ts dispatch relies on this.
- **Returning `false` from `process()`** — only after the `{__denCmd: "destroy"}` message has freed all WASM-side allocations. Returning `false` while allocations are live leaks the WASM heap bytes permanently.

## 5. Review expectations

A reviewer will:

- Open the Vercel preview, spot-check the catalog page (A/B, waveform, spectrogram, every slider).
- Read the Rust kernel against the cited reference; flag any deviation from the formula.
- Verify the scipy reference matches the Rust kernel at the claimed null-test tolerance.
- Check the commit history includes the scaffold commit + focused follow-ups (not one giant squash).

## 6. Commit conventions

- `chore(<effect>): scaffold` — initial scaffold commit
- `feat(<effect>): ...` — landing the effect implementation
- `test(<effect>): ...` — test-only changes
- `fix(<effect>): ...` — bug fixes post-merge

Signoff is not required.

## 7. Maintainer: Vercel preview setup (one-time, repo owner)

The CI jobs in `.github/workflows/ci.yml` install Rust + binaryen + Vite+ + Playwright automatically; there is no secret to configure.

The Vercel side uses **native GitHub integration** (no GitHub Actions YAML, no `VERCEL_TOKEN` secret). The repo owner configures it once at https://vercel.com:

1. Vercel dashboard → **Add New** → **Project** → import `yuichkun/den` via the Vercel ↔ GitHub integration.
2. Project settings:
   - **Root Directory**: `.`
   - **Framework Preset**: `Other`
   - **Install Command**: `./scripts/vercel-install.sh`
   - **Build Command**: `./scripts/vercel-build.sh`
   - **Output Directory**: `packages/examples/dist`
3. Save. Vercel deploys a preview for every PR (~3-4 min cold, ~60 s warm) and posts the URL via its built-in bot comment. Production deploys happen on merge to `main`.

`vercel.ts` at the repo root mirrors these settings in version control so they don't silently drift. Per [Vercel docs](https://vercel.com/docs/project-configuration/vercel-ts), the dashboard reads it on each build.

If the dashboard project has not been created yet by the time a PR lands, Tier3b is "run locally to review" — use `vp run build && vp run -F @denaudio/examples dev`.
