# den-kit · working Draft prototype

A musician-facing, manual patching sketch built on the real public den package
and unworklet **0.4.1**. It is separate from the developer code playground and
does not change the library's exports or production deployment. This Draft
branch has its own guarded Vercel preview build; main's playground is unchanged.

**Draft PR only. Do not merge this prototype to main.** No registry publication,
production deployment, Portal/DAW acceptance, or human listening approval is
implied. `den-kit` remains a provisional English product spelling.

## Try it

From the repository, use Node 24 and the existing root dependencies:

```sh
npm ci
node scripts/build-den-kit.mjs
```

The command packs the exact den source, installs a locked isolated consumer,
runs its strict types, graph tests and native numerical audio tests, then builds
the app. It prints the temporary consumer's `dist` path. Serve that directory
with a normal static server on localhost; do not deploy it as the den homepage.
The consumer can be deleted after review.

The Draft branch's `vercel.json` stages the same packed app into
`den-kit-preview-dist`. Its staging entrypoint refuses production, development,
missing deployment context and any branch except `feature/den-kit-prototype`.
The Preview exposes only the application's public commit/package provenance.
Do not promote this deployment or merge the branch.

The canonical complete gate is:

```sh
npm exec -- playwright install --with-deps chromium
node scripts/test-den-kit.mjs
```

This adds real browser interactions/audio/lifecycle checks and desktop/mobile
screenshots under `artifacts/den-kit`. The dedicated GitHub workflow runs this
against the exact PR head alongside the repository's unchanged Entry gate.

For iterative development, the isolated consumer has `npm run dev`, `check` and
`build` scripts. Run `npm run build` before previewing a production build: the
compiler's official Binaryen ESM is emitted as a separate asset. Do not import
arbitrary processor source into this app.

## Interaction

- Start from **Amber keys**, **Slow orbit**, or an empty patch.
- Click **Apply & play**. Nothing plays automatically. Amber keys responds to
  the on-screen keyboard or A W S E D F T G Y H U J K. Slow orbit is a drone.
- Click or drag a palette item to add it. Drag a module header to move it.
- Connect by dragging from output to input, or by clicking the two ports.
  Keyboard users can focus port buttons and use Enter. Escape cancels a cable.
- Select a cable and press Delete, or focus it and press Delete. Module removal
  removes its incident cables. Add an explicit Mix block to sum two signals.
- Face controls are live native AudioParams. Waveform/filter-mode or cable
  changes require **Apply**, which restarts the graph and clears its history.
- Undo/redo applies to graph, layout and control edits. Import/export stores a
  versioned JSON patch locally. Invalid imports leave the current patch alone.
- Stop disposes the node, compiler worker and AudioContext. Panic immediately
  mutes and resets all DSP; play a fresh note or Apply to resume.

The output listening level starts at 25% and is capped at 50%. This is a host
listening control, not normalization or a limiter. Patches can amplify signals;
the scope/meter shows actual post-master output. Keep listening volume low.

## Implemented slice

Nine module types: monophonic Note In, sine/saw Oscillator, three-response SV
Filter, ADSR, sine LFO, VCA, two-input Mix, Ping Pong delay and Audio Out. The
initial application bounds are 16 modules and 32 cables, one Note In and one
Audio Out. These are prototype constraints, not den library limits or a tested
real-time capacity guarantee for every combination/device.

Audio cables declare mono/stereo explicitly. Audio Out accepts either and
duplicates mono to L/R. Ping Pong explicitly duplicates its mono input before
the native stereo delay. Pitch cables carry Hz; gate/trigger ports carry bool;
CV carries f32 with units/depth documented in the inspector. Unlike Grid, the
prototype does not treat all signals as interchangeable stereo cables or run
every signal at 4× sample rate. It rejects unsupported conversions and cycles.

Filter resonance is restricted to Q ≤ 4 and delay feedback to ±0.85 in this
curated app. Other controls also use explicit musical editing ranges. These
bounds do not redefine den's public DSP contracts. There is no promise of
click-free extreme parameter automation or universally safe arbitrary patches.

## Native execution and state

`src/graph.ts` owns the application document and validation; `processor.ts`
lowers it directly into public `defineProcessor`, `instantiate` and den module
calls. Each stateful block is instantiated once and ticked once per sample.
An output fan-out reuses that tick's value.

The unworklet 0.4.1 compiler recursively expands expression DAGs. The first
default graph exposed a 19 MB WASM function and was rejected by the engine.
The adapter now materializes output ports once using transient native f64
scratch scaled by the exact power `2**128`, then converts back to f32. This
preserves tiny finite f32 values across the dependency's small-state flush.
Cutoff controls are separately materialized before filter evaluation. There is
no custom audio-thread scheduler, parameter transport, runtime or snapshot codec.

The compiler runs in a cancellable worker with a 20-second deadline. Only
validated, allowlisted graph data reaches it; no source eval, remote module
imports, service credentials or AI network calls are involved. Standard native
metadata emission and createNode load the worklet. Apply owns a fresh 48-kHz
AudioContext so registered WASM modules cannot accumulate across edits. Stop,
navigation or a newer audible edit cancels an in-progress Apply.

The editable patch document is distinct from DSP history. Import and structural
Apply start cold; this prototype does not use cross-schema snapshot restoration,
automatic migrations, or promise seamless live topology changes. Node layout
does not change the structural key and does not rebuild audio. Saved controls
are applied via native initial AudioParams.

## Verification and limits

The numerical tests independently check sine PCM, stereo duplication, fan-out,
VCA gain, disconnected silence, filter response and a known delay. Both default
patches compile and the drone renders finite nonzero audio without scrubs.
Browser tests must separately verify note release, Panic, live controls,
real cable editing, import/export, undo/movement, cancellation, repeated Apply,
navigation and viewport containment. Generated audio remains **CANDIDATE**.

The initial local shell browser cannot launch because its ProcessSingleton
socket is prohibited. That is an unverified browser stage, not a pass; exact-head
GitHub CI is the canonical native browser route. Source review and numerical
evidence do not replace screenshots or the real browser gate.

Deferred: full den catalog palette, polyphony/MPE, external MIDI/microphone
permissions, arbitrary graph feedback, seamless topology/state carryover,
AI chat/service integration, UI/presentation editing, platform asset panel,
Portal auth/iframe/DAW integration, Electron and independent VST export.

## Design intent and references

The product concept is a musician-editable environment for den-sized blocks,
with manual work and future AI work addressing the same graph. Portal embedding
remains the product premise. This prototype is exploratory review material,
not a final product design or an ownership decision.

The layout uses a category palette, direct module controls, colored cables,
grid canvas, inspector and output scope, inspired by these official references:

- [Bitwig Grid editor and module palette](https://www.bitwig.com/userguide/latest/welcome_to_the_grid/)
- [Bitwig signal semantics](https://www.bitwig.com/userguide/latest/on_grid_signals/)
- [Bitwig feedback boundaries](https://www.bitwig.com/userguide/latest/special_connections/)
- [Cycling '74 patch-cord interactions](https://docs.cycling74.com/userguide/patch_cords/)

No Bitwig/Cycling '74 artwork, presets, code or proprietary assets are bundled.
