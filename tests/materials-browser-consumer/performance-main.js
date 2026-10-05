import { createNode } from '@unworklet/core';
import processor from './performance-processor.ts?worklet';
window.runPerformance = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor, { initial: { a4: 375, gain: 1, release: .01 } });
    node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const mute = new GainNode(ctx, { gain: 0 });
    const analysers = ['main', 'frequency', 'level'].map(name => { const a = new AnalyserNode(ctx, { fftSize: 256 }); node.outputs[name].connect(a); a.connect(mute); return a; });
    mute.connect(ctx.destination); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .15, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('AudioContext did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      return analysers.map(a => {
        const x = new Float32Array(256); a.getFloatTimeDomainData(x);
        const bin = k => { let real = 0, imaginary = 0; for (let n = 0; n < 256; n++) { const phase = 2 * Math.PI * k * n / 256; real += x[n] * Math.cos(phase); imaginary -= x[n] * Math.sin(phase); } return 2 * Math.hypot(real, imaginary) / 256; };
        return { mean: x.reduce((s, v) => s + v, 0) / 256, peak: Math.max(...x.map(Math.abs)), finite: x.every(Number.isFinite), bin2: bin(2), bin4: bin(4) };
      });
    };
    const send = payload => node.midi.midi.send({ channel: 0, ...payload });
    const cc = (controller, value) => send({ type: 'cc', controller, value });
    const initial = await read(); send({ type: 'noteOn', note: 69, velocity: 127 }); const single = await read();
    node.params.a4.value = 750; const retuned = await read(); node.params.a4.value = 375; await read();
    send({ type: 'channelPressure', pressure: 127 }); cc(74, 127); send({ type: 'pitchBend', value: 16383 }); const expressive = await read();
    cc(64, 127); send({ type: 'noteOff', note: 69, velocity: 0 }); const sustained = await read(), saved = await node.snapshot();
    cc(64, 0); const released = await read();
    const restored = await node.restore(saved), afterRestore = await read();
    cc(121, 0); send({ type: 'noteOn', note: 69, velocity: 127 }); const controllerReset = await read();
    cc(120, 0); const panic = await read();
    return { sampleRate: ctx.sampleRate, initial, single, retuned, expressive, sustained, released, restored, afterRestore, controllerReset, panic, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
