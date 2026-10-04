# Consumer deployment

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
