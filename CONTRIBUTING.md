# Contributing to den

Use the [Vite+](https://viteplus.dev/) CLI (`vp`) for installs, checks, and scripts: run `vp install` after cloning, then `vp check` before pushing. Deeper workflow (issue templates, effect scaffolding, release process) is added in later foundation milestones.

## Maintainer setup (one-time, repo owner)

Sub C wires up the DSP test harness and the catalog site, both of which run automatically in CI and on Vercel. The CI side needs no manual setup beyond merging — the `test-tier2` and `test-tier3a` jobs in `.github/workflows/ci.yml` install Rust + binaryen + Vite+ + Playwright on each run.

The Vercel side uses **native GitHub integration** (no GitHub Actions YAML, no `VERCEL_TOKEN` secret). The repo owner configures it once at https://vercel.com:

1. Vercel dashboard → **Add New** → **Project** → import `yuichkun/den` via the Vercel ↔ GitHub integration.
2. Project settings:
   - **Root Directory**: `.`
   - **Framework Preset**: `Other`
   - **Install Command**: `./scripts/vercel-install.sh`
   - **Build Command**: `./scripts/vercel-build.sh`
   - **Output Directory**: `packages/examples/dist`
3. Save. Vercel will deploy a preview for every PR (~3-4 min cold, ~60 s warm) and post the URL via its built-in bot comment. Production deploys happen on merge to `main`.

`vercel.ts` at the repo root mirrors these settings in version control so they don't silently drift. Per [Vercel docs](https://vercel.com/docs/project-configuration/vercel-ts), the dashboard reads it on each build.

If the dashboard project has not been created yet by the time a PR lands, Tier3b is "run locally to review" — use `vp run build && vp run --filter @denaudio/examples dev`. (Issue #4 §8 Fallback #1.)
