import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "@unworklet/core";
import { makeProcessor } from "../src/processor.ts";
import { newNode, validate, parameters, presets } from "../src/graph.ts";
const edge = (id, a, ap, b, bp) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });
const tone = () => {
  const osc = newNode("oscillator", "osc", 0, 0);
  osc.mode = "sine";
  osc.params.frequency = 375;
  return {
    version: 1,
    name: "Numerical tone",
    nodes: [osc, newNode("output", "out", 300, 0)],
    edges: [edge("a", "osc", "out", "out", "in")],
  };
};
async function render(p, blocks = 24) {
  const result = await compile(makeProcessor(validate(p)), { sampleRate: 48000 }),
    driver = await result.driver.instantiate();
  const params = parameters(p),
    left = new Float32Array(blocks * 128),
    right = new Float32Array(blocks * 128),
    buffer = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    for (const declaration of driver.declarations)
      if (declaration.kind === "param")
        driver.writeParam(
          declaration.name,
          new Float32Array(128).fill(params[declaration.name] ?? declaration.default),
        );
    driver.process();
    driver.readOutput("main", 0, buffer);
    left.set(buffer, b * 128);
    driver.readOutput("main", 1, buffer);
    right.set(buffer, b * 128);
  }
  assert.equal(driver.scrubbedSamples(), 0);
  assert(left.every(Number.isFinite));
  return { left, right, wasmBytes: result.wasm.byteLength };
}
const peak = (x) => Math.max(...x.map(Math.abs));
const rms = (x) => Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length);
test(
  "real public den sine, stereo duplication and single-tick fan-out match analytic PCM",
  { timeout: 45000 },
  async () => {
    const p = tone(),
      a = await render(p);
    for (let i = 0; i < a.left.length; i++)
      assert(Math.abs(a.left[i] - Math.sin((2 * Math.PI * 375 * i) / 48000)) < 2e-6);
    assert.deepEqual(a.left, a.right);
    const mix = newNode("mixer", "mix", 200, 0);
    mix.params = { a: 0.25, b: 0.5 };
    p.nodes.push(mix);
    p.edges = [
      edge("a", "osc", "out", "mix", "a"),
      edge("b", "osc", "out", "mix", "b"),
      edge("c", "mix", "out", "out", "in"),
    ];
    const b = await render(p);
    for (let i = 0; i < b.left.length; i++) assert(Math.abs(b.left[i] - 0.75 * a.left[i]) < 2e-6);
  },
);
test("disconnect and VCA gain change actual native output", { timeout: 45000 }, async () => {
  const p = tone(),
    amp = newNode("vca", "amp", 100, 0);
  amp.params.gain = 0.125;
  p.nodes.push(amp);
  p.edges = [edge("a", "osc", "out", "amp", "in"), edge("b", "amp", "out", "out", "in")];
  const a = await render(p);
  assert(Math.abs(peak(a.left) - 0.125) < 2e-6);
  p.edges = p.edges.filter((e) => e.to.node !== "out");
  const off = await render(p);
  assert.equal(peak(off.left), 0);
});
test(
  "filter cutoff wiring matches independent steady-state analog-to-digital response",
  { timeout: 45000 },
  async () => {
    const p = tone(),
      f = newNode("filter", "filter", 100, 0);
    f.params = { cutoff: 1000, q: Math.SQRT1_2, depth: 0 };
    p.nodes[0].params.frequency = 1000;
    p.nodes.push(f);
    p.edges = [edge("a", "osc", "out", "filter", "in"), edge("b", "filter", "out", "out", "in")];
    const x = await render(p, 40);
    assert(Math.abs(rms(x.left.slice(-1920)) * Math.SQRT2 - Math.SQRT1_2) < 0.003);
  },
);
test(
  "delay cable carries the known sample delay, not an oscillator bypass",
  { timeout: 45000 },
  async () => {
    const p = tone(),
      d = newNode("delay", "delay", 100, 0);
    d.params = { time: 0.01, feedback: 0, mix: 1 };
    p.nodes.push(d);
    p.edges = [edge("a", "osc", "out", "delay", "in"), edge("b", "delay", "out", "out", "in")];
    const x = await render(p);
    for (let i = 0; i < 479; i++) assert.equal(x.left[i], 0);
    for (let i = 481; i < x.left.length; i++)
      assert(Math.abs(x.left[i] - Math.sin((2 * Math.PI * 375 * (i - 480)) / 48000)) < 3e-6);
    assert.deepEqual(x.left, x.right);
  },
);
test(
  "both default patches compile: keys stay silent without notes; drone is finite and audible",
  { timeout: 60000 },
  async () => {
    const a = await render(presets()[0], 4);
    assert.equal(peak(a.left), 0);
    const b = await render(presets()[1]);
    assert(rms(b.left) > 0.01);
    assert(peak(b.left) < 0.5);
  },
);
test(
  "scaled native scratch preserves tiny f32 audio against independent analytic samples",
  { timeout: 45000 },
  async () => {
    const p = tone(),
      amp = newNode("vca", "amp", 100, 0);
    amp.params.gain = 1e-35;
    p.nodes.push(amp);
    p.edges = [edge("a", "osc", "out", "amp", "in"), edge("b", "amp", "out", "out", "in")];
    const result = await render(p, 4),
      gain = Math.fround(1e-35);
    assert(
      peak(result.left) > 9.9e-36,
      "Sub-threshold audio must survive the scratch state, not flush to silence",
    );
    for (let i = 0; i < result.left.length; i++) {
      const expected = Math.fround(Math.fround(Math.sin((2 * Math.PI * 375 * i) / 48000)) * gain);
      assert(Math.abs(result.left[i] - expected) < 8e-41, `Independent tiny-f32 sample ${i}`);
    }
  },
);
