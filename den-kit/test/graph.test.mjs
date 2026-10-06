import test from "node:test";
import assert from "node:assert/strict";
import {
  validate,
  parsePatch,
  presets,
  newNode,
  History,
  dspKey,
  parameters,
} from "../src/graph.ts";
const clone = () => structuredClone(presets()[0]);
test("preset documents and history round-trip without changing DSP on movement", () => {
  for (const p of presets()) assert.deepEqual(parsePatch(JSON.stringify(p)), p);
  const p = clone(),
    h = new History(p),
    key = dspKey(p),
    moved = structuredClone(p);
  moved.nodes[0].x += 8;
  h.commit(moved);
  assert.equal(dspKey(h.patch), key);
  assert(h.undo());
  assert.deepEqual(h.patch, p);
  assert(h.redo());
  assert.deepEqual(h.patch, moved);
  h.undo();
  h.commit({ ...p, name: "New name" });
  assert(!h.canRedo);
});
test("validation rejects malformed imports, executable fields and finite bounds", () => {
  for (const mutate of [
    (p) => (p.version = 2),
    (p) => (p.nodes[0].id = p.nodes[1].id),
    (p) => (p.nodes[0].kind = "eval"),
    (p) => (p.nodes[0].source = "alert(1)"),
    (p) => (p.nodes[0].x = NaN),
    (p) => (p.nodes[1].params.frequency = Infinity),
    (p) => (p.nodes[1].params.frequency = -1),
    (p) => (p.nodes[1].params.extra = 4),
    (p) => (p.nodes[1].mode = "square"),
    (p) => p.nodes.push(newNode("note", "other", 0, 0)),
    (p) => (p.edges[0].from.node = "missing"),
    (p) => (p.edges[0].to.port = "missing"),
  ]) {
    const p = clone();
    mutate(p);
    assert.throws(() => validate(p));
  }
  assert.throws(() => parsePatch(" ".repeat(100001)));
  assert.throws(() => parsePatch('{"version":1}'));
});
test("one cable per inlet, actual signal/channel types, and DAG cycles are enforced", () => {
  const p = clone();
  p.edges.push({ ...p.edges[0], id: "duplicate" });
  assert.throws(() => validate(p), /one cable/);
  const bad = clone();
  bad.edges[0].from.port = "gate";
  assert.throws(() => validate(bad), /Incompatible/);
  const stereo = clone();
  stereo.edges = stereo.edges.filter((e) => e.to.node !== "filter");
  stereo.edges.push({
    id: "stereo",
    from: { node: "echo", port: "out" },
    to: { node: "filter", port: "in" },
  });
  assert.throws(() => validate(stereo), /Incompatible/);
  const cycle = clone();
  cycle.edges = cycle.edges.filter((e) => e.to.node !== "filter");
  cycle.edges.push({
    id: "loop",
    from: { node: "amp", port: "out" },
    to: { node: "filter", port: "in" },
  });
  assert.throws(() => validate(cycle), /Feedback/);
});
test("native parameter keys are stable and values use float32", () => {
  const p = clone();
  p.nodes[1].params.frequency = 333.333;
  assert.equal(parameters(p).osc_frequency, Math.fround(333.333));
  const n = structuredClone(p);
  n.nodes[1].mode = "sine";
  assert.notEqual(dspKey(p), dspKey(n));
  assert.equal(
    dspKey(p),
    dspKey({ ...p, nodes: [...p.nodes].reverse(), edges: [...p.edges].reverse() }),
  );
});
