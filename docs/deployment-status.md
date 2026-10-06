# Catalog deployment

The versioned production build is `npm run build:site`. Its public map is:

- `/`: searchable source/effect/control catalog, with actual audition links
- `/catalog.html`: four musical A/B studies
- `/playground.html`: the existing instrument and stereo FX playground

`/diagnostics.html` and `/audition.html` are removed from the public output,
including their exclusive assets. They are not hidden links or redirects. Silent
package/snapshot and Envelope/LFO behavior remain covered by the independent
entry, audition and realtime tests, using their original isolated consumers.

The build validates catalog metadata against every actual public package export
and checked-in contract. It builds two isolated locked audio consumers, requires
identical package integrity, then starts from a clean `site-dist` and copies only
those consumers' outputs plus the static catalog. Distinct assets with the same
name cause a hard failure. No diagnostic consumer is built into the public site.

The deployment smoke test serves those exact bytes. It verifies the three-page
inventory and removed-route 404s; desktop/mobile layout, filtering, empty/reset
states, keyboard details and browser Back/Forward; safe deep links, no autoplay,
real nonzero audio, repeated release/stop and closed native contexts. The
canonical eight-row A/B stereo and interrupted/touch lifecycle gate is retained.

The Vercel project keeps `npm ci --include=dev`, build `npm run build:site`,
framework none and output `site-dist`. No project, production branch,
authentication, access, environment or response-header settings are changed.
Review and exact-head CI precede main integration. A successful build or deploy
is not runtime clearance, device certification or golden approval. See
[current acceptance boundaries](initial-acceptance.md).

## Historical entry-gate deployment repair

The following records the original G0 repair and its then-current `build:consumer`
route. It is now a test-only fixture and is not staged by the public site build.

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

## Public listening routes

`/catalog.html` is the A/B listening destination. `/playground.html` is the
instrument/FX destination. Both use the same shared catalog navigation and
explicit user gestures to start audio. `?example=` on the A/B page and
`?instrument=&effect=` on the playground accept only known settings. Invalid
values fall back to existing defaults and never create audio contexts.

The standalone `build:catalog` and `build:integration` outputs retain their
fixture roots; only the combined site build adds public navigation.
