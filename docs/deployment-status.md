# Consumer deployment

The versioned build for the initial candidate is `npm run build:site`:

- `/`: integrated Diagnostic / Bass / Percussion / Pad × three Delay settings
- `/diagnostics.html`: silent package gain/snapshot check
- `/audition.html`: retained Envelope/LFO module audition

The build packs the same source into two isolated locked consumers, requires
identical package integrity, typechecks/builds both, and copies only their Vite
outputs into `site-dist`. Distinct outputs with the same asset name cause a hard
failure. The deployment smoke test serves those exact bytes, not the source tree.
`build:consumer` and `build:integration` remain available for focused local work.
The repository's Vercel build command is now `build:site`; install remains
`npm ci --include=dev`, framework is none, and output remains `site-dist`.

This replaces the former branch-only integration preview override. It does not
change the Vercel project, production branch, authentication, sharing, permissions
or response headers. Review and exact-head CI precede main integration; the
existing Vercel check must pass on the final head. A successful build or deploy
is not runtime clearance, physical-device certification, or golden approval.
See [current acceptance boundaries](initial-acceptance.md).

## Historical entry-gate deployment repair

The following records the original G0 repair and its then-current `build:consumer`
route. That route is preserved at `/diagnostics.html` by the current site build.

The failure on `3ea862b1cb7b9fa37afa892e51606ea0556a35ae` is confirmed by the
[deployment log](https://vercel.com/escentier/den/7XCUWxMzapFEBzsQhipQ7UhakxXd):

```text
Running install command './scripts/vercel-install.sh'
sh: line 1: ./scripts/vercel-install.sh: No such file or directory
```

That command belonged to the retired Rust/Vite+ stack. Repository-local
`vercel.json` now explicitly overrides install, build, framework detection, and
output using the fresh TypeScript project:

- Install: `npm ci --include=dev` (the static build requires TypeScript/Vite).
- Build: `npm run build:consumer`.
- Static output: `site-dist` (not library `dist`).
- Framework: none; the build invokes Vite explicitly for the real consumer.

The build uses `scripts/build-consumer.mjs` to pack den, install the artifact in
an isolated temporary consumer with locked dependencies, check its public types,
and build its actual HTML/JavaScript/AudioWorklet/WASM assets. Only that consumer's
production output is copied into `site-dist`. The entry integration test calls the
same build function and serves `site-dist` before asserting real browser results.
Failures from packing, installation, checking, or bundling fail the build; this is
not a placeholder success page or a disabled deployment.

The page provides a user-triggered silent 48-kHz check of gain changes and snapshot
restoration, displaying success only when measured samples and restore status
match. The production browser test clicks the button and verifies its result.
There is no new runtime/loader and no Rust setup. Browser 44.1/96-kHz support is
not claimed; offline coverage is separate. No COOP/COEP header override is added:
the existing unworklet postMessage transport is the path exercised here.

Build configuration is versioned in the repository; no dashboard, security,
credential, permission, or check-disabling change is required. See Vercel's
[file-based configuration](https://vercel.com/docs/project-configuration) for
install/build/output overrides. The deployment must pass on the final reviewed
commit; a previous failed status is not waived by a local build.
