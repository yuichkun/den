# Code playground deployment

The previous public UI was deleted and its production routes and asset URLs
verified absent before this replacement was started. The new root is an
English, code-first playground. It is a work-in-progress Preview until the
replacement PR's exact-head browser, review and CI gates are accepted.

The production command remains `npm run build:site`, with output `site-dist/`
and no Vercel project, access, authentication, domain or security-setting
changes. The builder packs the current repository source, installs the isolated
`playground/` consumer from its lockfile, checks its types and exhaustive public
export/example coverage, and replaces the public output with its built files.
Actual package, declaration and example hashes are emitted in `provenance.json`.

`/catalog.html`, `/audition.html`, `/diagnostics.html`, `/playground.html` and
former asset paths remain absent. No old product page is redirected or hidden
behind the editor. The only public application route is `/`, with `?module=`
selecting a bundled example without autoplay.

Library/DSP sources, exports and history are preserved. Historical browser
surfaces remain test fixtures only. `tests/site-fixture-build.mjs` builds them
outside public output, preserving all earlier numerical, native state, MIDI,
keyboard/touch and interrupted-audio assertions. The production build never
calls that fixture helper.

`tests/site-removal.test.mjs` poisons the public directory with old routes and
assets and verifies they are physically removed. `tests/site.test.mjs` tests the
actual packed replacement: Monaco assistance, editable sources, native audio,
Run/Stop/retry/cancellation, navigation/search and mobile layout. Its dedicated
Preview job runs a bounded generator/effect slice for early feedback; full
entry runs every example. Screenshots and manifests retain the exact source
and packed-package identity. Browser checks and listening approval are separate.

All development commands (`build:consumer`, `build:integration`, `build:catalog`
and the manual realtime probe) use isolated temporary output.
`buildConsumer({stageSite: true})` is rejected before packing/installing.
Only `build:site` owns public `site-dist`.
