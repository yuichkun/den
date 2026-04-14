# @denaudio/effects

High-level audio effects for the browser, backed by Rust/WASM kernels and
running inside an AudioWorklet. Part of [`den`](https://github.com/yuichkun/den).

## Install

```sh
npm install @denaudio/effects
```

## Usage

Every effect follows the same two-phase shape: an idempotent async
`register(ctx)` that loads the WASM and installs the worklet module on a
context, then a synchronous `new Effect(ctx, options)` constructor that
can be called any number of times (one node per use).

```ts
import { Gain } from "@denaudio/effects";

const ctx = new AudioContext();
await Gain.register(ctx); // once per context
const gain = new Gain(ctx, { gain: 0.5 }); // initial -6 dB

source.connect(gain).connect(ctx.destination);

// AudioParam automation works as-is.
gain.gain.setValueAtTime(1.0, ctx.currentTime);
gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 2.0);

// When done — frees the WASM-side state.
gain.dispose();
```

`gain` clamps silently to `[0, 10]` (linear). Step changes are smoothed
with a 1-pole exponential, tau = 20 ms, so `setValueAtTime` produces no
audible click even on ±∞ dB jumps.

## Effects

| Class         | Status          | Notes                                           |
| ------------- | --------------- | ----------------------------------------------- |
| `Gain`        | shipped (Sub D) | linear gain, a-rate AudioParam, 20 ms smoothing |
| `Passthrough` | `@internal`     | identity — used by the test harness             |

More effects land via the [add-effect issue template](https://github.com/yuichkun/den/issues) (Sub E).

## License

MIT OR Apache-2.0.
