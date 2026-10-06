# den playground

Each module opens a normal TypeScript processor using real public imports from
`@denaudio/den` and `@unworklet/core`. Edit the graph, press **Run**, and use its
native AudioParams. Nothing plays automatically. The output level starts at 25%.
Input processors receive the visible, adjustable Web Audio source; generators do
not need an input. Stop closes the AudioContext and disposes the native node.

The module list covers every public package export exactly once. Each example
imports and uses its named module in a meaningful audio graph. Helper modules
are demonstrated through composition. These are runnable examples, not approved
reference recordings or a claim of real-time performance on every device.

## Source format

A `.processor.ts` file exports a default `CompiledProcessor` made with
`defineProcessor`. Use one `main` output with one or two channels. The host uses
48 kHz. Code is checked against the declarations from the same installed, packed
den package used to compile it. Completion, hover, signatures and errors come
from the real TypeScript language service, not hand-written declaration stubs.

Optional named exports are **plain playground setup data**, not additional den
or unworklet APIs:

- `initial`: numeric AudioParam values passed to `createNode`.
- `events`: `{ name, payload }` packets sent by `node.events[name].emit(payload)`.
- `midi`: `{ port, event }` messages sent by `node.midi[port].send(event)`.
- `ready`: `{ suffix, value }` state checks against
  `inspect(await node.snapshot()).slots` after event delivery.
- `afterReady`: AudioParam values applied after those checks with
  `node.params[name].setValueAtTime(value, context.currentTime)`.

Samples that need PCM or impulses generate that data visibly in their source.
The node is connected and processing, with output muted, while assets load.
Readiness has a five-second deadline; a missing state, timeout or native error
stops the run and displays a failure. The host then sends MIDI and unmutes only
when preparation succeeds. The Host setup panel shows the native calls made for
the current run. It is an explanatory excerpt, not a standalone application.

The native node is built with the public `compile`, `extractWorkletMeta`,
`emitWorkletModuleSource` and `createNode` APIs. The emitted worklet uses a bundle
of the official `@unworklet/core/worklet` runtime. See
[`src/compiler.worker.ts`](src/compiler.worker.ts) and
[`src/audio-session.ts`](src/audio-session.ts) for the complete host implementation.

Compilation is cancellable and has a 20-second deadline. The dedicated worker
keeps accidental graph-building loops away from the UI and is terminated by
Stop, source changes or navigation. A worker is **not a security sandbox**.
Run only source you trust. The app does not import code from URL parameters,
autorun shared source, or request a microphone.

## Build

The public build packs the current repository head and installs it into an
isolated consumer using this directory's lockfile. It checks types, verifies
54/54 example coverage against actual package exports, captures actual package
declarations, and builds the app. Only the generated app is staged in
`site-dist`; former public audition and diagnostic routes stay absent.

Monaco 0.55.1, TypeScript 5.9.3 and esbuild 0.28.2 are isolated to this app.
The library's unworklet 0.4.1 dependency is unchanged. Large compiler dependencies
are served as separate browser modules to keep the build bounded. Binaryen's
published ESM is copied without modifying its semantics.

Browser acceptance covers completion and diagnostics, audible native output,
repeat/Stop, cancellation/error/retry, navigation, search and mobile layout.
Numerical render tests are distinct from listening acceptance.
