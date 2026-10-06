import { createNode, inspect, type CompiledProcessor, type UnworkletNode } from '@unworklet/core';
import { makeWorkletNamespaceFromMeta, type WorkletMeta } from '@unworklet/core/worklet';
import CompilerWorker from './compiler.worker.ts?worker';
import type { SampleSetup } from './sample-setup.ts';
import type { Diagnostic } from './typescript-project.ts';
export type Phase = 'idle' | 'compiling' | 'preparing' | 'playing' | 'stopping' | 'error';
type Compiled = { meta: WorkletMeta; setup: SampleSetup; moduleSource: string; wasm: ArrayBuffer; processorName: string; sampleRate: number };
type Session = {
  id: number; ctx: AudioContext; abort: AbortController; worker?: Worker; node?: UnworkletNode<unknown>;
  urls: string[]; master?: GainNode; raw?: AnalyserNode; output?: AnalyserNode;
  source?: OscillatorNode | AudioBufferSourceNode; input?: GainNode; pulseTimer?: ReturnType<typeof setInterval>;
  nextPulse?: number; disposal?: Promise<void>; nodeDisposed?: boolean;
};
export type LiveParameter = { name: string; min: number; max: number; value: number; defaultValue: number };
export class AudioSession {
  phase: Phase = 'idle'; message = 'Audio is stopped.'; error: string | null = null;
  parameters: LiveParameter[] = []; setup: SampleSetup | null = null; inputNames: string[] = [];
  volume = .25; inputLevel = .1; inputFrequency = 110; inputType: OscillatorType | 'noise' = 'sawtooth'; pulsed = false;
  created = 0; closed = 0; disposed = 0;
  private current: Session | null = null; private serial = 0;
  constructor(private update: () => void, private diagnostics: (value: Diagnostic[], version: number) => void) {}
  private live(s: Session) { return this.current === s && !s.abort.signal.aborted; }
  private notify(phase: Phase, message: string) { this.phase = phase; this.message = message; this.update(); }
  private wait<T>(promise: Promise<T>, s: Session, milliseconds: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => { clearTimeout(timer); s.abort.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value as T); };
      const abort = () => finish(new Error('Run cancelled.'));
      const timer = setTimeout(() => finish(new Error(message)), milliseconds);
      s.abort.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => finish(undefined, value), error => finish(error));
      if (s.abort.signal.aborted) abort();
    });
  }
  private compile(s: Session, source: string, version: number): Promise<Compiled> {
    const worker = s.worker = new CompilerWorker();
    const result = new Promise<Compiled>((resolve, reject) => {
      worker.onmessage = event => {
        const data = event.data;
        if (!this.live(s) || data.id !== s.id) return;
        if (data.phase) this.notify('compiling', `${data.phase}…`);
        if (data.error) { this.diagnostics(data.diagnostics ?? [], version); reject(new Error(data.error)); }
        else if (data.result) resolve(data.result);
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message || 'Compilation worker failed.')); };
      worker.onmessageerror = () => reject(new Error('Compilation response could not be read.'));
      worker.postMessage({ id: s.id, source });
    });
    return this.wait(result, s, 20000, 'Compilation timed out. Stop loops or try a smaller graph.').finally(() => { worker.terminate(); if (s.worker === worker) s.worker = undefined; });
  }
  async run(source: string, version: number): Promise<void> {
    if (['compiling', 'preparing', 'stopping'].includes(this.phase)) return;
    const previous = this.stop();
    let ctx: AudioContext;
    try { ctx = new AudioContext({ sampleRate: 48000 }); }
    catch (error) { await previous.catch(() => {}); this.error = String(error); this.notify('error', 'Audio could not start.'); return; }
    // Resume is requested synchronously in the Run gesture, before compilation.
    const resumed = ctx.resume();
    const s: Session = { id: ++this.serial, ctx, abort: new AbortController(), urls: [] };
    this.current = s; this.created++; this.error = null; this.setup = null; this.parameters = []; this.inputNames = [];
    this.notify('compiling', 'Checking types…');
    try {
      await this.wait(resumed, s, 5000, 'Audio context did not resume.'); await previous;
      if (!this.live(s)) return;
      if (ctx.sampleRate !== 48000) throw new Error('This playground requires a 48 kHz AudioContext.');
      const data = await this.compile(s, source, version); if (!this.live(s)) return;
      this.notify('preparing', 'Preparing audio…');
      const moduleUrl = URL.createObjectURL(new Blob([data.moduleSource], { type: 'text/javascript' }));
      const wasmUrl = URL.createObjectURL(new Blob([data.wasm], { type: 'application/wasm' }));
      s.urls.push(moduleUrl, wasmUrl);
      const processor = { worklet: { ...makeWorkletNamespaceFromMeta(data.meta), moduleUrl, wasmUrl, processorName: data.processorName, displayName: 'den playground', bakedSampleRate: data.sampleRate } } as CompiledProcessor<unknown>;
      const pending = createNode(ctx, processor, { initial: data.setup.initial });
      pending.then(node => { if (!this.live(s)) { node.dispose(); this.disposed++; } }, () => {});
      const node = await this.wait(pending, s, 15000, 'AudioWorklet did not become ready.'); if (!this.live(s)) return;
      s.node = node; this.setup = data.setup;
      node.onError(error => { if (error.code !== 'sab-unavailable' && this.live(s)) void this.fail(s, 'message' in error ? error.message : JSON.stringify(error)); });
      s.master = new GainNode(ctx, { gain: 0 }); s.raw = new AnalyserNode(ctx, { fftSize: 2048 }); s.output = new AnalyserNode(ctx, { fftSize: 2048 });
      if (!Object.hasOwn(node.outputs, 'main')) throw new Error('The processor has no main audio output.');
      node.outputs.main!.connect(s.raw); s.raw.connect(s.master); s.master.connect(s.output); s.output.connect(ctx.destination);
      this.inputNames = Object.keys(node.inputs);
      if (this.inputNames.length) {
        s.input = new GainNode(ctx, { gain: 0 });
        for (const input of Object.values(node.inputs)) s.input.connect(input);
        this.makeSource(s);
      }
      for (const item of data.setup.events) {
        if (!Object.hasOwn(node.events, item.name)) throw new Error(`Unknown native event: ${item.name}`);
        node.events[item.name]!.emit(item.payload as never);
      }
      await this.acknowledge(s, data.setup);
      if (!this.live(s)) return;
      for (const [name, value] of Object.entries(data.setup.afterReady)) {
        if (!Object.hasOwn(node.params, name)) throw new Error(`Unknown AudioParam in afterReady: ${name}`);
        node.params[name]!.setValueAtTime(value, ctx.currentTime);
      }
      for (const item of data.setup.midi) {
        if (!Object.hasOwn(node.midi, item.port)) throw new Error(`Unknown native MIDI port: ${item.port}`);
        node.midi[item.port]!.send(item.event);
      }
      this.parameters = Object.entries(node.params).map(([name, parameter]) => ({ name, min: parameter.minValue, max: parameter.maxValue, value: parameter.value, defaultValue: parameter.defaultValue }));
      this.applyInput(s);
      s.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + .025);
      this.notify('playing', 'Running');
    } catch (error) { if (this.live(s)) await this.fail(s, error instanceof Error ? error.message : String(error)); }
    finally { if (!this.live(s)) await this.dispose(s); }
  }
  private async acknowledge(s: Session, setup: SampleSetup): Promise<void> {
    if (!setup.ready.length) return;
    const deadline = performance.now() + 5000;
    while (this.live(s)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Asset preparation timed out: ${setup.ready.map(item => item.suffix).join(', ')}`);
      const state = inspect(await this.wait(s.node!.snapshot(), s, remaining, 'Native asset acknowledgement timed out.'));
      const missing: string[] = [];
      for (const check of setup.ready) {
        const matches = Object.entries(state.slots).filter(([name]) => name.endsWith(check.suffix));
        if (!matches.length) throw new Error(`Readiness state not found: ${check.suffix}`);
        if (!matches.every(([, slot]) => slot.kind === 'state' && slot.value === check.value)) missing.push(check.suffix);
      }
      if (!missing.length) return;
      this.notify('preparing', `Waiting for ${missing.join(', ')}…`);
      await this.wait(new Promise(resolve => setTimeout(resolve, 15)), s, remaining, 'Asset preparation timed out.');
    }
    throw new Error('Run cancelled.');
  }
  private makeSource(s: Session) {
    if (!s.input) return;
    try { s.source?.stop(); } catch {} s.source?.disconnect();
    if (this.inputType === 'noise') {
      const buffer = s.ctx.createBuffer(1, 48000, 48000), samples = buffer.getChannelData(0); let seed = 1234567;
      for (let i = 0; i < samples.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; samples[i] = seed / 2147483648 - 1; }
      s.source = new AudioBufferSourceNode(s.ctx, { buffer, loop: true });
    } else s.source = new OscillatorNode(s.ctx, { type: this.inputType, frequency: this.inputFrequency });
    s.source.connect(s.input); s.source.start();
  }
  private applyInput(s: Session) {
    if (!s.input) return;
    clearInterval(s.pulseTimer);
    const gain = s.input.gain, now = s.ctx.currentTime;
    gain.cancelScheduledValues(now); gain.setValueAtTime(0, now);
    if (!this.pulsed) { gain.linearRampToValueAtTime(this.inputLevel, now + .01); return; }
    s.nextPulse = now + .01;
    const schedule = () => {
      if (!this.live(s) || !s.input) return;
      while (s.nextPulse! < s.ctx.currentTime + 1.5) {
        const at = s.nextPulse!; gain.setValueAtTime(0, at); gain.linearRampToValueAtTime(this.inputLevel, at + .01); gain.setValueAtTime(this.inputLevel, at + .24); gain.linearRampToValueAtTime(0, at + .26); s.nextPulse! += .7;
      }
    };
    schedule(); s.pulseTimer = setInterval(schedule, 500);
  }
  setInput(options: { type?: OscillatorType | 'noise'; frequency?: number; level?: number; pulsed?: boolean }) {
    const changed = options.type !== undefined && options.type !== this.inputType;
    if (options.type !== undefined) this.inputType = options.type;
    if (options.frequency !== undefined) this.inputFrequency = Math.max(20, Math.min(2000, options.frequency));
    if (options.level !== undefined) this.inputLevel = Math.max(0, Math.min(.25, options.level));
    if (options.pulsed !== undefined) this.pulsed = options.pulsed;
    const s = this.current;
    if (s && this.phase === 'playing') {
      if (changed) this.makeSource(s);
      if (s.source instanceof OscillatorNode) s.source.frequency.setValueAtTime(this.inputFrequency, s.ctx.currentTime);
      this.applyInput(s);
    }
    this.update();
  }
  setVolume(value: number) { this.volume = Math.max(0, Math.min(1, value)); const s = this.current; if (s?.master && this.phase === 'playing') s.master.gain.setTargetAtTime(this.volume, s.ctx.currentTime, .01); this.update(); }
  setParameter(name: string, value: number) { const s = this.current, parameter = s?.node?.params[name]; if (!s || !parameter || this.phase !== 'playing' || !Number.isFinite(value)) return; parameter.setValueAtTime(Math.max(parameter.minValue, Math.min(parameter.maxValue, value)), s.ctx.currentTime); const item = this.parameters.find(item => item.name === name); if (item) item.value = parameter.value; }
  private async fail(s: Session, message: string) { if (!this.live(s)) return; await this.stop(); if (this.current || this.serial !== s.id) return; this.error = message; this.notify('error', 'Run failed'); }
  clearError() { if (this.phase === 'error') { this.error = null; this.notify('idle', 'Run to apply your changes.'); } }
  private dispose(s: Session): Promise<void> {
    if (s.disposal) return s.disposal;
    s.disposal = (async () => {
      s.worker?.terminate(); s.worker = undefined; clearInterval(s.pulseTimer);
      try { s.source?.stop(); } catch {} s.source?.disconnect();
      if (s.node && !s.nodeDisposed) { s.nodeDisposed = true; s.node.dispose(); this.disposed++; }
      try { if (s.ctx.state !== 'closed') await s.ctx.close(); } finally { this.closed++; for (const url of s.urls) URL.revokeObjectURL(url); s.urls.length = 0; }
    })();
    return s.disposal;
  }
  async stop(message = 'Audio is stopped.', immediate = false): Promise<void> {
    const s = this.current; if (!s) return;
    this.current = null; s.abort.abort(); s.worker?.terminate(); clearInterval(s.pulseTimer);
    this.notify('stopping', 'Stopping…');
    if (!immediate && s.master && s.ctx.state !== 'closed') {
      const now = s.ctx.currentTime;
      if (s.master.gain.cancelAndHoldAtTime) s.master.gain.cancelAndHoldAtTime(now);
      else { s.master.gain.cancelScheduledValues(now); s.master.gain.setValueAtTime(s.master.gain.value, now); }
      s.master.gain.linearRampToValueAtTime(0, now + .02); await new Promise(resolve => setTimeout(resolve, 30));
    }
    await this.dispose(s);
    if (!this.current) { this.parameters = []; this.inputNames = []; this.notify('idle', message); }
  }
  state() { return { phase: this.phase, message: this.message, error: this.error, created: this.created, closed: this.closed, disposed: this.disposed, contextState: this.current?.ctx.state ?? 'closed', volume: this.volume, params: this.parameters.map(x => ({ ...x })), inputNames: [...this.inputNames] }; }
  samples(postMaster = true) { const analyser = postMaster ? this.current?.output : this.current?.raw; const data = new Float32Array(2048); analyser?.getFloatTimeDomainData(data); return data; }
  measure() { const stats = (x: Float32Array) => ({ peak: Math.max(...x.map(Math.abs)), rms: Math.sqrt(x.reduce((sum, value) => sum + value * value, 0) / x.length), finite: x.every(Number.isFinite) }); return { raw: stats(this.samples(false)), output: stats(this.samples(true)), ...this.state() }; }
}
