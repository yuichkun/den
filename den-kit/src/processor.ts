import {
  audioOutput,
  bool,
  defineProcessor,
  event,
  f32,
  f64,
  forSample,
  instantiate,
  param,
  select,
  state,
  type Node,
} from "@unworklet/core";
import { oscillator } from "@denaudio/den/oscillator";
import { stateVariableFilter } from "@denaudio/den/state-variable-filter";
import { envelope } from "@denaudio/den/envelope";
import { lfo, modulateCutoff } from "@denaudio/den/lfo";
import { pingPongDelay } from "@denaudio/den/stereo-delay";
import { voicePolicy } from "@denaudio/den/voice-policy";
import { modules, ordered, parameterName, validate, type Patch } from "./graph.ts";
type Float = Node<"f32">;
type Flag = Node<"bool">;
type Signal =
  | {
      kind: "float";
      value: Float;
    }
  | {
      kind: "gate";
      value: Flag;
    }
  | {
      kind: "audio";
      samples: Float[];
    };
/** Lower only validated editor data into public den subgraphs. No source eval. */
export function makeProcessor(input: Patch) {
  const patch = validate(input),
    order = ordered(patch);
  return defineProcessor(({ sampleRate }) => {
    const output = audioOutput({ name: "main", channels: 2 });
    const reset = state.bool(false).expose({ name: "panic", snapshot: "transient" });
    event<{
      value: number;
    }>({ from: "main", name: "reset" }).onReceive(() => reset.write(true));
    const controls = new Map(
      patch.nodes.map((n) => [
        n.id,
        Object.fromEntries(
          Object.entries(modules[n.kind].controls).map(([key, c]) => [
            key,
            param
              .f32({ default: n.params[key]!, min: c.min, max: c.max, automationRate: "a-rate" })
              .named(parameterName(n.id, key)),
          ]),
        ),
      ]),
    );
    // Every module gets one independent, stable instance. Structural Apply is a
    // cold start; editor imports never restore incompatible native snapshots.
    const entries = order.map((n) => {
      const options = { name: n.id };
      switch (n.kind) {
        case "oscillator":
          return [
            n.id,
            {
              kind: "oscillator" as const,
              unit: instantiate(
                oscillator,
                { sampleRate, waveform: n.mode as "sine" | "saw" },
                options,
              ),
            },
          ] as const;
        case "filter":
          return [
            n.id,
            {
              kind: "filter" as const,
              unit: instantiate(stateVariableFilter, { sampleRate }, options),
            },
          ] as const;
        case "envelope":
          return [
            n.id,
            { kind: "envelope" as const, unit: instantiate(envelope, { sampleRate }, options) },
          ] as const;
        case "lfo":
          return [
            n.id,
            { kind: "lfo" as const, unit: instantiate(lfo, { sampleRate }, options) },
          ] as const;
        case "delay":
          return [
            n.id,
            {
              kind: "delay" as const,
              unit: instantiate(pingPongDelay, { sampleRate, maxDelaySeconds: 1 }, options),
            },
          ] as const;
        default:
          return [n.id, { kind: "utility" as const }] as const;
      }
    });
    const instances = new Map<string, (typeof entries)[number][1]>(entries);
    const noteNode = patch.nodes.find((n) => n.kind === "note");
    const policy = noteNode
      ? instantiate(
          voicePolicy,
          { mode: "mono", capacity: 1, heldCapacity: 16, legato: true },
          { name: noteNode.id },
        )
      : null;
    if (policy) policy.bindMidi(event.midi({ from: "main", name: "midi" }));
    const tuning = policy
      ? state.buffer.f32({ size: 128 }).expose({ name: "tuning", snapshot: "transient" })
      : null;
    // Core 0.4.1 recursively expands expression DAGs. Materialize port values
    // once, including fan-out, before downstream modules expand them again.
    // Scale f64 scratch by an exact power of two so native tiny-state flushing
    // cannot silently remove finite f32 audio/control values.
    const scale = 2 ** 128;
    const slots = new Map<string, number>();
    let count = 0;
    for (const n of order)
      for (const p of modules[n.kind].outputs) {
        slots.set(`${n.id}.${p.id}`, count);
        count += p.channels ?? 1;
      }
    const scratch = state.buffer
      .f64({ size: Math.max(1, count) })
      .expose({ name: "ports", snapshot: "transient" });
    const flags = state.buffer
      .bool({ size: Math.max(1, count) })
      .expose({ name: "flags", snapshot: "transient" });
    const cutoffs = state.buffer
      .f32({ size: Math.max(1, order.length) })
      .expose({ name: "cutoffs", snapshot: "transient" });
    return {
      process() {
        policy?.reset(reset.read());
        if (tuning)
          for (let note = 0; note < 128; note++) tuning.write(note, 440 * 2 ** ((note - 69) / 12));
        forSample((i) => {
          const values = new Map<string, Signal>();
          const signal = (node: string, port: string) => {
            const e = patch.edges.find((e) => e.to.node === node && e.to.port === port);
            return e ? values.get(`${e.from.node}.${e.from.port}`) : undefined;
          };
          const scalar = (node: string, port: string, fallback: Float = f32(0)) => {
            const s = signal(node, port);
            return s?.kind === "float" ? s.value : fallback;
          };
          const gate = (node: string, port: string) => {
            const s = signal(node, port);
            return s?.kind === "gate" ? s.value : bool(false);
          };
          const audio = (node: string, port: string) => {
            const s = signal(node, port);
            return s?.kind === "audio" ? s.samples : [f32(0)];
          };
          const set = (id: string, port: string, s: Signal) => {
            const key = `${id}.${port}`,
              slot = slots.get(key)!;
            if (s.kind === "gate") {
              flags.write(slot, s.value);
              values.set(key, { kind: "gate", value: flags.read(slot) });
            } else if (s.kind === "float") {
              scratch.write(slot, f64(s.value).mul(scale));
              values.set(key, { kind: "float", value: f32(scratch.read(slot).div(scale)) });
            } else {
              s.samples.forEach((v, i) => scratch.write(slot + i, f64(v).mul(scale)));
              values.set(key, {
                kind: "audio",
                samples: s.samples.map((_, i) => f32(scratch.read(slot + i).div(scale))),
              });
            }
          };
          for (const n of order) {
            const ps = controls.get(n.id)!;
            const p = (key: string) => ps[key]!.at(i);
            const inst = instances.get(n.id)!;
            if (n.kind === "note" && policy && tuning) {
              const voice = policy.voices[0]!,
                v = voice.read();
              set(n.id, "pitch", { kind: "float", value: tuning.read(v.note.max(0)) });
              set(n.id, "gate", { kind: "gate", value: v.gate.and(reset.read().not()) });
              set(n.id, "trigger", {
                kind: "gate",
                value: voice.takeRetrigger().and(reset.read().not()),
              });
              set(n.id, "velocity", { kind: "float", value: v.velocity });
            } else if (inst.kind === "oscillator") {
              set(n.id, "out", {
                kind: "audio",
                samples: [
                  inst.unit.tick(
                    scalar(n.id, "pitch", p("frequency")),
                    reset.read().or(gate(n.id, "reset")),
                  ),
                ],
              });
            } else if (inst.kind === "filter") {
              const cutoff = modulateCutoff(
                p("cutoff"),
                scalar(n.id, "mod"),
                p("depth"),
                Math.min(20000, 0.45 * sampleRate),
              );
              const index = order.indexOf(n);
              cutoffs.write(index, cutoff);
              const result = inst.unit.tick(
                audio(n.id, "in")[0]!,
                cutoffs.read(index),
                p("q"),
                reset.read(),
              );
              set(n.id, "out", {
                kind: "audio",
                samples: [result[n.mode as "lowpass" | "bandpass" | "highpass"]],
              });
            } else if (inst.kind === "envelope") {
              const result = inst.unit.tick({
                gate: gate(n.id, "gate"),
                retrigger: gate(n.id, "trigger"),
                reset: reset.read(),
                attack: p("attack"),
                decay: p("decay"),
                sustain: p("sustain"),
                release: p("release"),
              });
              set(n.id, "out", { kind: "float", value: result.level });
            } else if (inst.kind === "lfo") {
              set(n.id, "out", {
                kind: "float",
                value: inst.unit.tick(p("rate"), reset.read(), f32(0)),
              });
            } else if (inst.kind === "delay") {
              const source = audio(n.id, "in")[0]!;
              const result = inst.unit.tick(source, source, {
                timeSeconds: p("time"),
                feedback: p("feedback"),
                mix: p("mix"),
                bypass: bool(false),
                reset: reset.read(),
              });
              set(n.id, "out", { kind: "audio", samples: [result.left, result.right] });
            } else if (n.kind === "vca")
              set(n.id, "out", {
                kind: "audio",
                samples: [
                  audio(n.id, "in")[0]!
                    .mul(scalar(n.id, "level", f32(1)).clamp(0, 1))
                    .mul(p("gain")),
                ],
              });
            else if (n.kind === "mixer")
              set(n.id, "out", {
                kind: "audio",
                samples: [
                  audio(n.id, "a")[0]!
                    .mul(p("a"))
                    .add(audio(n.id, "b")[0]!.mul(p("b"))),
                ],
              });
            else if (n.kind === "output") {
              const samples = audio(n.id, "in");
              output
                .ch(0)
                .at(i)
                .write(select(reset.read(), f32(0), samples[0]!));
              output
                .ch(1)
                .at(i)
                .write(select(reset.read(), f32(0), samples[1] ?? samples[0]!));
            }
          }
          if (!patch.nodes.some((n) => n.kind === "output")) {
            output.ch(0).at(i).write(0);
            output.ch(1).at(i).write(0);
          }
          reset.write(false);
        });
      },
    };
  });
}
