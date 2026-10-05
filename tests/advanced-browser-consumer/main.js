import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runAdvanced = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor); node.onError(e => errors.push({ ...e, message: String(e.message ?? '') }));
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 9 }), mute = new GainNode(ctx, { gain: 0 }); node.outputs.main.connect(splitter);
    const analysers = Array.from({ length: 9 }, (_, ch) => { const a = new AnalyserNode(ctx, { fftSize: 256 }); splitter.connect(a, ch); a.connect(mute); return a; }); mute.connect(ctx.destination); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .15, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('AudioContext did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      return analysers.map(a => {
        const x = new Float32Array(256); a.getFloatTimeDomainData(x);
        const bin = k => { let re = 0, im = 0; for (let n = 0; n < 256; n++) { const p = 2 * Math.PI * k * n / 256; re += x[n] * Math.cos(p); im -= x[n] * Math.sin(p); } return { re: 2 * re / 256, im: 2 * im / 256, amplitude: 2 * Math.hypot(re, im) / 256 }; };
        return { mean: x.reduce((s, v) => s + v, 0) / 256, rms: Math.sqrt(x.reduce((s, v) => s + v * v, 0) / 256), peak: Math.max(...x.map(Math.abs)), finite: x.every(Number.isFinite), bins: { 28: bin(28), 32: bin(32), 36: bin(36) } };
      });
    };
    const initial = await read(), saved = await node.snapshot();
    node.params.shift.value = -750; node.params.ceiling.value = -12; node.params.ratio.value = 100; node.params.ordinate.value = .5; const edited = await read();
    node.params.bypass.value = 1; const bypassed = await read();
    const restored = await node.restore(saved), afterRestore = await read();
    node.params.reset.value = 1; const reset = await read();
    return { sampleRate: ctx.sampleRate, initial, edited, bypassed, restored, afterRestore, reset, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
