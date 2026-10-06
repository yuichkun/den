# Public site removal

The existing website is removed before a new catalog is built. The production
command remains `npm run build:site`, with output `site-dist/` and no Vercel
project, access, authentication, domain or security-setting changes.

The build deletes the previous output directory and writes only `index.html`,
a minimal rebuilding notice. It ships no scripts, stylesheets, navigation,
players, links or audio assets. `/catalog.html`, `/audition.html`,
`/diagnostics.html`, `/playground.html` and former asset paths are absent and
must return 404. The previous pages are not redirected or hidden behind links.

Library/DSP sources, exports and repository history are preserved. Historical
browser surfaces are test fixtures only. `tests/site-fixture-build.mjs` builds
them into a temporary directory from identical locked packed consumers;
`tests/site-fixture.test.mjs` retains their earlier integration checks, and the
canonical catalog lifecycle test still exercises all eight musical-example
variations, native state, output, cancellation, keyboard and touch behavior.
The production build does not call that fixture helper.

`tests/site-removal.test.mjs` poisons an output directory with former pages and
assets and verifies they are physically removed. `tests/site.test.mjs` serves
the actual minimal output, checks the old routes return 404, and records the
root's absence of former controls/scripts/assets. Review, exact-head CI and
actual production verification are required before declaring removal complete.
No replacement interface is included in this deletion change.

All development commands (`build:consumer`, `build:integration`, `build:catalog`
and the manual realtime probe) now use isolated temporary output.
`buildConsumer({stageSite: true})` is rejected before packing/installing, so a
test helper cannot repopulate public `site-dist`. Only `build:site` owns it.
