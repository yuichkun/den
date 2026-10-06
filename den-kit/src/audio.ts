import { createNode, type CompiledProcessor, type UnworkletNode } from "@unworklet/core";
import { makeWorkletNamespaceFromMeta, type WorkletMeta } from "@unworklet/core/worklet";
import Compiler from "./compiler.worker.ts?worker";
import { validate, parameters, dspKey, type Patch } from "./graph.ts";
type Compiled = {
  meta: WorkletMeta;
  moduleSource: string;
  wasm: ArrayBuffer;
  processorName: string;
};
type Session = {
  id: number;
  context: AudioContext;
  abort: AbortController;
  worker?: Worker;
  node?: UnworkletNode<unknown>;
  master?: GainNode;
  meter?: AnalyserNode;
  urls: string[];
  disposed?: Promise<void>;
};
export class AudioEngine {
  phase: "idle" | "compiling" | "playing" | "error" = "idle";
  error = "";
  appliedKey = "";
  volume = 0.25;
  created = 0;
  closed = 0;
  disposed = 0;
  private serial = 0;
  private request = 0;
  private closing: Promise<void> = Promise.resolve();
  private current: Session | null = null;
  private silence = false;
  constructor(private update: () => void) {}
  private live(s: Session) {
    return this.current === s && !s.abort.signal.aborted;
  }
  private wait<T>(task: Promise<T>, s: Session, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        s.abort.signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve(value as T);
      };
      const cancel = () => finish(new Error("Cancelled."));
      const timer = setTimeout(
        () => finish(new Error("Audio preparation timed out. Try fewer modules.")),
        ms,
      );
      s.abort.signal.addEventListener("abort", cancel, { once: true });
      task.then(
        (v) => finish(undefined, v),
        (e) => finish(e),
      );
      if (s.abort.signal.aborted) cancel();
    });
  }
  async apply(value: Patch) {
    let patch: Patch;
    try {
      patch = validate(value);
    } catch (e) {
      this.error = String(e);
      this.update();
      return;
    }
    // A newer Apply or Stop invalidates startup even while a previous close is
    // still pending. Never allocate a replacement until audio resources release.
    const request = ++this.request;
    const old = this.releaseCurrent();
    this.phase = "compiling";
    this.error = "";
    this.update();
    try {
      await old;
    } catch (error) {
      if (request === this.request) {
        this.phase = "error";
        this.error = `Previous audio context could not close: ${String(error)}`;
        this.update();
      }
      return;
    }
    if (request !== this.request) return;
    // Each Apply deliberately owns a fresh context; old registered WASM cannot accumulate.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: 48000 });
    } catch (e) {
      this.error = String(e);
      this.phase = "error";
      this.update();
      return;
    }
    const resumed = context.resume();
    const s: Session = { id: ++this.serial, context, abort: new AbortController(), urls: [] };
    this.current = s;
    this.created++;
    this.phase = "compiling";
    this.error = "";
    this.silence = false;
    this.update();
    try {
      await this.wait(resumed, s, 5000);
      if (!this.live(s)) return;
      if (context.sampleRate !== 48000)
        throw new Error("This prototype requires a 48 kHz AudioContext.");
      const worker = (s.worker = new Compiler());
      const pending = new Promise<Compiled>((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.id !== s.id || !this.live(s)) return;
          data.error ? reject(new Error(data.error)) : resolve(data.result);
        };
        worker.onerror = (e) => {
          e.preventDefault();
          reject(new Error(e.message));
        };
        worker.onmessageerror = () => reject(new Error("Compiler response could not be read."));
        worker.postMessage({ id: s.id, patch });
      });
      const data = await this.wait(pending, s, 20000);
      worker.terminate();
      s.worker = undefined;
      if (!this.live(s)) return;
      const moduleUrl = URL.createObjectURL(
        new Blob([data.moduleSource], { type: "text/javascript" }),
      );
      const wasmUrl = URL.createObjectURL(new Blob([data.wasm], { type: "application/wasm" }));
      s.urls.push(moduleUrl, wasmUrl);
      const processor = {
        worklet: {
          ...makeWorkletNamespaceFromMeta(data.meta),
          moduleUrl,
          wasmUrl,
          processorName: data.processorName,
          displayName: "den-kit prototype",
          bakedSampleRate: 48000,
        },
      } as CompiledProcessor<unknown>;
      const native = createNode(context, processor, { initial: parameters(patch) });
      native.then(
        (node) => {
          if (!this.live(s)) {
            node.dispose();
            this.disposed++;
          }
        },
        () => {},
      );
      const node = await this.wait(native, s, 15000);
      if (!this.live(s)) return;
      s.node = node;
      node.onError((e) => {
        if (e.code !== "sab-unavailable" && this.live(s))
          void this.fail(s, "message" in e ? e.message : JSON.stringify(e));
      });
      s.master = new GainNode(context, { gain: 0 });
      s.meter = new AnalyserNode(context, { fftSize: 2048 });
      node.outputs.main!.connect(s.master);
      s.master.connect(s.meter);
      s.meter.connect(context.destination);
      s.master.gain.linearRampToValueAtTime(this.volume, context.currentTime + 0.025);
      this.appliedKey = dspKey(patch);
      this.phase = "playing";
      this.update();
    } catch (e) {
      if (this.live(s)) await this.fail(s, e instanceof Error ? e.message : String(e));
    } finally {
      if (!this.live(s)) await this.dispose(s);
    }
  }
  private async fail(s: Session, message: string) {
    const request = ++this.request;
    try {
      await this.releaseCurrent();
    } catch {
      /* Retain the original runtime failure. */
    }
    if (this.current || this.serial !== s.id || request !== this.request) return;
    this.phase = "error";
    this.error = message;
    this.update();
  }
  updateParameters(patch: Patch) {
    const s = this.current;
    if (!s?.node || this.phase !== "playing" || dspKey(patch) !== this.appliedKey) return;
    for (const [name, value] of Object.entries(parameters(patch))) {
      const p = s.node.params[name];
      if (p)
        p.setValueAtTime(
          Math.fround(Math.max(p.minValue, Math.min(p.maxValue, value))),
          s.context.currentTime,
        );
    }
  }
  setVolume(value: number) {
    if (!Number.isFinite(value)) return;
    this.volume = Math.max(0, Math.min(0.5, value));
    const s = this.current;
    if (s?.master && !this.silence)
      s.master.gain.setTargetAtTime(this.volume, s.context.currentTime, 0.01);
  }
  note(note: number, on: boolean) {
    const s = this.current;
    if (!s?.node || this.phase !== "playing") return;
    if (this.silence && on) {
      this.silence = false;
      s.master?.gain.setTargetAtTime(this.volume, s.context.currentTime, 0.01);
    }
    s.node.midi.midi?.send({
      type: on ? "noteOn" : "noteOff",
      channel: 0,
      note,
      velocity: on ? 96 : 0,
    });
  }
  panic() {
    const s = this.current;
    if (!s?.node) return;
    this.silence = true;
    s.master?.gain.cancelScheduledValues(s.context.currentTime);
    s.master?.gain.setValueAtTime(0, s.context.currentTime);
    s.node.events.reset?.emit({ value: 1 });
    this.update();
  }
  samples() {
    const x = new Float32Array(2048);
    this.current?.meter?.getFloatTimeDomainData(x);
    return x;
  }
  state() {
    const x = this.samples();
    return {
      phase: this.phase,
      error: this.error,
      appliedKey: this.appliedKey,
      created: this.created,
      closed: this.closed,
      disposed: this.disposed,
      contextState: this.current?.context.state ?? "closed",
      volume: this.volume,
      panicked: this.silence,
      peak: Math.max(...x.map(Math.abs)),
      rms: Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length),
      finite: x.every(Number.isFinite),
    };
  }
  private dispose(s: Session) {
    return (s.disposed ??= (async () => {
      s.worker?.terminate();
      if (s.node) {
        s.node.dispose();
        this.disposed++;
      }
      try {
        if (s.context.state !== "closed") await s.context.close();
      } finally {
        this.closed++;
        s.urls.forEach((url) => URL.revokeObjectURL(url));
        s.urls = [];
      }
    })());
  }
  private releaseCurrent(): Promise<void> {
    const s = this.current;
    if (!s) return this.closing;
    this.current = null;
    s.abort.abort();
    s.worker?.terminate();
    if (s.master && s.context.state !== "closed") {
      s.master.gain.cancelScheduledValues(s.context.currentTime);
      s.master.gain.setValueAtTime(0, s.context.currentTime);
    }
    this.phase = "idle";
    this.update();
    this.closing = Promise.all([this.closing, this.dispose(s)]).then(() => {});
    return this.closing;
  }
  async stop() {
    ++this.request;
    this.error = "";
    this.phase = "idle";
    this.update();
    try {
      await this.releaseCurrent();
    } catch (error) {
      if (!this.current) {
        this.phase = "error";
        this.error = `Audio context could not close: ${String(error)}`;
      }
    }
    if (!this.current) this.update();
  }
}
