/** The editor document is application data, never a den DSP/state format. */
export type Kind =
  | "note"
  | "oscillator"
  | "filter"
  | "envelope"
  | "lfo"
  | "vca"
  | "mixer"
  | "delay"
  | "output";
export type Domain = "audio" | "cv" | "gate" | "pitch";
export type Port = {
  id: string;
  label: string;
  domain: Domain;
  channels?: number;
  description: string;
};
export type Control = {
  label: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  log?: boolean;
  step?: number;
};
export type Module = {
  title: string;
  category: string;
  color: string;
  description: string;
  inputs: Port[];
  outputs: Port[];
  controls: Record<string, Control>;
  modes?: string[];
};
const port = (
  id: string,
  label: string,
  domain: Domain,
  description: string,
  channels?: number,
): Port => ({ id, label, domain, description, channels });
const c = (
  label: string,
  min: number,
  max: number,
  value: number,
  unit = "",
  log = false,
): Control => ({ label, min, max, default: value, unit, log });
export const modules: Record<Kind, Module> = {
  note: {
    title: "Note In",
    category: "I/O",
    color: "#e6ae50",
    description:
      "One monophonic voice. Last held note wins; note-off returns to the previous held key. Computer keys A W S E D F T G Y H U J K or the keyboard below.",
    inputs: [],
    outputs: [
      port("pitch", "Pitch", "pitch", "Equal-tempered pitch in Hz, A4 = 440 Hz."),
      port("gate", "Gate", "gate", "True while a note is held."),
      port("trigger", "Trigger", "gate", "One-sample retrigger pulse."),
      port("velocity", "Velocity", "cv", "Unipolar velocity, 0–1."),
    ],
    controls: {},
  },
  oscillator: {
    title: "Oscillator",
    category: "Oscillator",
    color: "#df655b",
    description:
      "den oscillator: sine or polynomial-BLEP saw. Pitch cable replaces the frequency knob. Waveform changes take effect on Apply.",
    inputs: [
      port("pitch", "Pitch", "pitch", "Frequency in Hz; unconnected uses Frequency."),
      port("reset", "Reset", "gate", "True resets phase. Use a trigger, not a held gate."),
    ],
    outputs: [port("out", "Out", "audio", "Mono signal, nominally −1 to +1.", 1)],
    controls: { frequency: c("Frequency", 20, 2000, 220, "Hz", true) },
    modes: ["saw", "sine"],
  },
  filter: {
    title: "SV Filter",
    category: "Filter",
    color: "#df8c57",
    description:
      "den trapezoidal state-variable filter. Cutoff modulation is bipolar; depth is in octaves. Resonance can amplify audio; watch the output level.",
    inputs: [
      port("in", "In", "audio", "Mono audio input; silence when unconnected.", 1),
      port("mod", "Cutoff mod", "cv", "Bipolar modulation scaled by Depth in octaves."),
    ],
    outputs: [
      port("out", "Out", "audio", "Selected low-pass, band-pass or high-pass response.", 1),
    ],
    controls: {
      cutoff: c("Cutoff", 20, 20000, 1800, "Hz", true),
      q: c("Resonance", 0.5, 4, 0.707, "Q"),
      depth: c("Mod depth", -4, 4, 1.5, "oct"),
    },
    modes: ["lowpass", "bandpass", "highpass"],
  },
  envelope: {
    title: "ADSR",
    category: "Envelope",
    color: "#dbb444",
    description:
      "den ADSR. Attack, decay and release latch on segment entry. Sustain follows live edits. Unpatched Gate is off.",
    inputs: [
      port("gate", "Gate", "gate", "True starts/holds; false releases."),
      port("trigger", "Trigger", "gate", "One-sample retrigger while gate is true."),
    ],
    outputs: [port("out", "Level", "cv", "Unipolar envelope, 0–1.")],
    controls: {
      attack: c("Attack", 0, 3, 0.012, "s"),
      decay: c("Decay", 0, 3, 0.16, "s"),
      sustain: c("Sustain", 0, 1, 0.65),
      release: c("Release", 0, 4, 0.35, "s"),
    },
  },
  lfo: {
    title: "LFO",
    category: "Modulator",
    color: "#67bcb7",
    description:
      "den free-running sine LFO. A bipolar −1 to +1 control signal. Destination depth is set at the receiving module.",
    inputs: [],
    outputs: [port("out", "Signal", "cv", "Bipolar sine, −1 to +1.")],
    controls: { rate: c("Rate", 0.05, 20, 0.7, "Hz", true) },
  },
  vca: {
    title: "VCA",
    category: "Level",
    color: "#9eacb0",
    description:
      "Explicit gain multiplication. Unpatched Level uses unity so drones work. A connected envelope replaces that unity level.",
    inputs: [
      port("in", "In", "audio", "Mono audio.", 1),
      port("level", "Level", "cv", "Linear gain clamped to 0–1; unconnected = 1."),
    ],
    outputs: [port("out", "Out", "audio", "Input × Level × Gain.", 1)],
    controls: { gain: c("Gain", 0, 1, 0.22) },
  },
  mixer: {
    title: "Mix",
    category: "Level",
    color: "#9eacb0",
    description: "Two mono signals with independent linear gains. Summing can increase peak level.",
    inputs: [
      port("a", "A", "audio", "First mono input.", 1),
      port("b", "B", "audio", "Second mono input.", 1),
    ],
    outputs: [port("out", "Out", "audio", "A × A gain + B × B gain.", 1)],
    controls: { a: c("A gain", 0, 1, 0.5), b: c("B gain", 0, 1, 0.5) },
  },
  delay: {
    title: "Ping Pong",
    category: "Delay",
    color: "#9c87c8",
    description:
      "den stereo cross-feedback delay. Mono input is explicitly duplicated into both channels. Capacity is fixed at 1 second; Apply resets its tail.",
    inputs: [port("in", "In", "audio", "Mono source duplicated to L/R.", 1)],
    outputs: [port("out", "Stereo", "audio", "Two-channel delay output.", 2)],
    controls: {
      time: c("Time", 0.01, 1, 0.28, "s"),
      feedback: c("Feedback", -0.85, 0.85, 0.32),
      mix: c("Mix", 0, 1, 0.23),
    },
  },
  output: {
    title: "Audio Out",
    category: "I/O",
    color: "#e6ae50",
    description:
      "Stereo output. Mono is duplicated to both channels. Master level is a separate listening control. No limiter or hidden normalization.",
    inputs: [port("in", "In", "audio", "Accepts mono or stereo; unconnected is silence.")],
    outputs: [],
    controls: {},
  },
};
export type PatchNode = {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  params: Record<string, number>;
  mode?: string;
};
export type Edge = {
  id: string;
  from: {
    node: string;
    port: string;
  };
  to: {
    node: string;
    port: string;
  };
};
export type Patch = {
  version: 1;
  name: string;
  nodes: PatchNode[];
  edges: Edge[];
};
export const LIMITS = { nodes: 16, edges: 32, bytes: 100000 } as const;
export function newNode(kind: Kind, id: string, x: number, y: number): PatchNode {
  const m = modules[kind];
  return {
    id,
    kind,
    x,
    y,
    params: Object.fromEntries(Object.entries(m.controls).map(([k, v]) => [k, v.default])),
    ...(m.modes ? { mode: m.modes[0] } : {}),
  };
}
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) =>
  Object.keys(x).every((k) => allowed.includes(k));
const ident = (x: unknown): x is string =>
  typeof x === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(x);
export function validate(value: unknown): Patch {
  if (
    !record(value) ||
    !keys(value, ["version", "name", "nodes", "edges"]) ||
    value.version !== 1 ||
    typeof value.name !== "string" ||
    value.name.length > 80 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    throw new Error("Expected a version 1 patch with a name, nodes and cables.");
  if (value.nodes.length > LIMITS.nodes || value.edges.length > LIMITS.edges)
    throw new Error(`Prototype limit: ${LIMITS.nodes} modules and ${LIMITS.edges} cables.`);
  const ids = new Set<string>();
  for (const n of value.nodes) {
    if (
      !record(n) ||
      !keys(n, ["id", "kind", "x", "y", "params", "mode"]) ||
      !ident(n.id) ||
      ids.has(n.id) ||
      typeof n.kind !== "string" ||
      !Object.hasOwn(modules, n.kind) ||
      !record(n.params)
    )
      throw new Error("Unknown module, duplicate ID or malformed node.");
    ids.add(n.id);
    const m = modules[n.kind as Kind];
    if (
      ![n.x, n.y].every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 4000)
    )
      throw new Error("Module positions must be finite and inside the canvas.");
    if (
      Object.keys(n.params).length !== Object.keys(m.controls).length ||
      !keys(n.params, Object.keys(m.controls))
    )
      throw new Error(`Invalid controls on ${m.title}.`);
    for (const [key, d] of Object.entries(m.controls)) {
      const v = n.params[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < d.min || v > d.max)
        throw new Error(`${m.title}: ${d.label} must be ${d.min}–${d.max} ${d.unit}.`);
    }
    if (m.modes ? !m.modes.includes(n.mode as string) : n.mode !== undefined)
      throw new Error(`Invalid mode on ${m.title}.`);
  }
  const p = value as unknown as Patch;
  if (
    p.nodes.filter((n) => n.kind === "note").length > 1 ||
    p.nodes.filter((n) => n.kind === "output").length > 1
  )
    throw new Error("This prototype supports one Note In and one Audio Out.");
  const used = new Set<string>(),
    edgeIds = new Set<string>();
  for (const e of p.edges) {
    if (
      !record(e) ||
      !keys(e, ["id", "from", "to"]) ||
      !ident(e.id) ||
      edgeIds.has(e.id) ||
      !record(e.from) ||
      !record(e.to) ||
      !keys(e.from, ["node", "port"]) ||
      !keys(e.to, ["node", "port"])
    )
      throw new Error("Malformed or duplicate cable.");
    edgeIds.add(e.id);
    const source = p.nodes.find((n) => n.id === e.from.node),
      target = p.nodes.find((n) => n.id === e.to.node);
    const out = source && modules[source.kind].outputs.find((x) => x.id === e.from.port),
      input = target && modules[target.kind].inputs.find((x) => x.id === e.to.port);
    if (!source || !target || !out || !input)
      throw new Error("Cable references a missing module or port.");
    if (
      out.domain !== input.domain ||
      (input.channels !== undefined && out.channels !== input.channels)
    )
      throw new Error(
        `Incompatible cable: ${out.label} → ${input.label}. Use matching signal types/channels.`,
      );
    const endpoint = `${e.to.node}.${e.to.port}`;
    if (used.has(endpoint))
      throw new Error("An inlet accepts one cable. Use Mix to combine signals.");
    used.add(endpoint);
  }
  ordered(p);
  return structuredClone(p);
}
export function ordered(p: Patch): PatchNode[] {
  const result: PatchNode[] = [],
    done = new Set<string>(),
    visiting = new Set<string>();
  function visit(n: PatchNode) {
    if (done.has(n.id)) return;
    if (visiting.has(n.id))
      throw new Error("Feedback cables are not supported. Ping Pong has its own bounded feedback.");
    visiting.add(n.id);
    for (const e of p.edges.filter((e) => e.to.node === n.id)) {
      const from = p.nodes.find((x) => x.id === e.from.node);
      if (!from) throw new Error("Cable source is missing.");
      visit(from);
    }
    visiting.delete(n.id);
    done.add(n.id);
    result.push(n);
  }
  for (const n of p.nodes) visit(n);
  return result;
}
export function parsePatch(text: string): Patch {
  if (text.length > LIMITS.bytes) throw new Error("Patch file is too large (100 KB maximum).");
  return validate(JSON.parse(text));
}
export function dspKey(p: Patch): string {
  return JSON.stringify({
    nodes: p.nodes
      .map(({ id, kind, mode }) => ({ id, kind, mode }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: p.edges
      .map(({ from, to }) => ({ from, to }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export const parameterName = (id: string, key: string) => `${id}_${key}`;
export function parameters(p: Patch) {
  return Object.fromEntries(
    p.nodes.flatMap((n) =>
      Object.entries(n.params).map(([k, v]) => [parameterName(n.id, k), Math.fround(v)]),
    ),
  );
}
export function presets(): Patch[] {
  const nodes = [
    newNode("note", "note", 32, 48),
    newNode("oscillator", "osc", 256, 48),
    newNode("filter", "filter", 480, 48),
    newNode("vca", "amp", 704, 48),
    newNode("delay", "echo", 928, 48),
    newNode("output", "out", 1152, 48),
    newNode("envelope", "env", 256, 340),
    newNode("lfo", "lfo", 480, 400),
  ];
  const cable = (id: string, a: string, ap: string, b: string, bp: string): Edge => ({
    id,
    from: { node: a, port: ap },
    to: { node: b, port: bp },
  });
  const synth: Patch = {
    version: 1,
    name: "Amber keys",
    nodes,
    edges: [
      cable("e1", "note", "pitch", "osc", "pitch"),
      cable("e2", "note", "trigger", "osc", "reset"),
      cable("e3", "osc", "out", "filter", "in"),
      cable("e4", "filter", "out", "amp", "in"),
      cable("e5", "amp", "out", "echo", "in"),
      cable("e6", "echo", "out", "out", "in"),
      cable("e7", "note", "gate", "env", "gate"),
      cable("e8", "note", "trigger", "env", "trigger"),
      cable("e9", "env", "out", "amp", "level"),
      cable("e10", "lfo", "out", "filter", "mod"),
    ],
  };
  const drone: Patch = {
    version: 1,
    name: "Slow orbit",
    nodes: [
      newNode("oscillator", "osc", 90, 90),
      newNode("oscillator", "osc_b", 90, 350),
      newNode("mixer", "mix", 340, 90),
      newNode("filter", "filter", 590, 90),
      newNode("delay", "echo", 840, 90),
      newNode("output", "out", 1090, 90),
      newNode("lfo", "lfo", 590, 410),
    ],
    edges: [
      cable("e1", "osc", "out", "mix", "a"),
      cable("e2", "osc_b", "out", "mix", "b"),
      cable("e3", "mix", "out", "filter", "in"),
      cable("e4", "filter", "out", "echo", "in"),
      cable("e5", "echo", "out", "out", "in"),
      cable("e6", "lfo", "out", "filter", "mod"),
    ],
  };
  drone.nodes[0]!.params.frequency = 110;
  drone.nodes[1]!.params.frequency = 110.4;
  drone.nodes[2]!.params = { a: 0.09, b: 0.09 };
  drone.nodes[3]!.params = { cutoff: 700, q: 0.8, depth: 2 };
  drone.nodes[4]!.params.mix = 0.4;
  drone.nodes[6]!.params.rate = 0.12;
  return [validate(synth), validate(drone)];
}
export class History {
  private past: Patch[] = [];
  private future: Patch[] = [];
  public patch: Patch;
  constructor(patch: Patch) {
    this.patch = patch;
  }
  commit(next: Patch) {
    const p = validate(next);
    if (JSON.stringify(p) === JSON.stringify(this.patch)) return;
    this.past.push(structuredClone(this.patch));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
    this.patch = p;
  }
  undo() {
    const p = this.past.pop();
    if (p) {
      this.future.push(this.patch);
      this.patch = p;
    }
    return !!p;
  }
  redo() {
    const p = this.future.pop();
    if (p) {
      this.past.push(this.patch);
      this.patch = p;
    }
    return !!p;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
