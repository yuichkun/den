# Golden generator

Generate reference WAVs used by the Tier2 null-test runner.

## Setup

Install uv: https://docs.astral.sh/uv/getting-started/installation/

## Run

```bash
vp run gen-golden               # all effects
vp run gen-golden passthrough   # single effect
```

Outputs to `packages/test-utils/golden/<effect>/<preset>__<signal>.wav`.
These files are committed to the repo. CI does NOT regenerate.

## When to regenerate

- Adding a new effect (Sub E's add-effect template walks through it).
- Intentionally changing an algorithm — regenerate, commit, note in PR.
