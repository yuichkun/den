# Existing deployment integration

The entry deliverable is an ESM package and a temporary clean consumer exercised
by CI. `dist/` is library output, not a deployable website. GEN-610 does not require
hosting a website, so a Vercel build/output configuration is not required to prove
its package/export/consumer acceptance path.

The existing Vercel integration nevertheless posted a failed deployment for
`d20c75757bc4c3f4a1877fede5daed7a77aa6b75`:
[deployment details](https://vercel.com/escentier/den/7K3oMqw9aikJJw8Qb2V3SbCQEc3v).
The GitHub status only says deployment failed; it contains no build error/log.

Historical repository evidence: the removed `vercel.ts` at base commit `d69ee666`
said it mirrored dashboard settings and selected `scripts/vercel-install.sh`,
`scripts/vercel-build.sh`, and `packages/examples/dist`. Those scripts installed
Rust/WASM/Vite+ and built the retired examples. All of these paths were removed
as part of the complete legacy replacement. Stale dashboard commands are a
plausible cause, **not a verified diagnosis of the current deployment**.

Read-only investigation using Vercel CLI 62.2.0 `inspect <deployment> --logs` was
blocked by absent credentials. Direct Vercel access returned HTTP 403. No login,
credential, project setting, permission, check-disabling, or hosting change was
performed. GitHub branch-protection reads also returned integration-access 403;
therefore the Vercel status cannot be presumed optional for merge.

Disposition: keep this failure visible. An authorized maintainer needs to inspect
the actual current build log/settings and explicitly decide how the legacy site
integration should relate to the new package repository. If a new hosted consumer
is wanted, scope its real build/output and verification rather than point Vercel
at library `dist/` or disable deployment to manufacture a passing check. The entry
CI can pass independently, but merge readiness must separately account for this
external status. No repository-local deployment workaround is justified by the
available evidence.
