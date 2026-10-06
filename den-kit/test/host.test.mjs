import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
// Exercise the actual host class. Native creation is deliberately unavailable
// in this focused test; real AudioWorklet behavior belongs to the browser gate.
const built = await build({
  entryPoints: [fileURLToPath(new URL("../src/audio.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "host-test-boundaries",
      setup(api) {
        api.onResolve({ filter: /\?worker$|^@unworklet\/core(?:\/worklet)?$/ }, (args) => ({
          path: args.path,
          namespace: "test-boundary",
        }));
        api.onLoad({ filter: /.*/, namespace: "test-boundary" }, (args) => ({
          contents: args.path.endsWith("?worker")
            ? "export default class Worker {}"
            : args.path.endsWith("/worklet")
              ? 'export const makeWorkletNamespaceFromMeta=()=>{throw new Error("Native runtime not used in host test")};'
              : 'export const createNode=()=>{throw new Error("Native runtime not used in host test")};',
          loader: "js",
        }));
      },
    },
  ],
});
const { AudioEngine } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
);
test("Panic stays muted on noteOff; only a fresh noteOn resumes listening", () => {
  const events = [],
    ramps = [];
  const engine = new AudioEngine(() => {});
  engine.phase = "playing";
  engine.current = {
    context: { currentTime: 1 },
    node: {
      events: { reset: { emit: (v) => events.push(v) } },
      midi: { midi: { send: (v) => events.push(v) } },
    },
    master: {
      gain: {
        cancelScheduledValues() {},
        setValueAtTime() {},
        setTargetAtTime(...args) {
          ramps.push(args);
        },
      },
    },
  };
  engine.panic();
  assert.equal(engine.state().panicked, true);
  engine.note(48, false);
  assert.equal(engine.state().panicked, true, "noteOff must not release the Panic latch");
  assert.equal(ramps.length, 0);
  engine.note(48, true);
  assert.equal(engine.state().panicked, false);
  assert.equal(ramps.length, 1);
  assert.equal(events.at(-1).type, "noteOn");
});
