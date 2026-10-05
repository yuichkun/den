import { createNode } from '@unworklet/core';
import processor from './wave-processor.ts?worklet';
window.runWaves = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor); node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 5 }), mute = new GainNode(ctx, { gain: 0 }); node.outputs.main.connect(splitter);
    const analysers = Array.from({ length: 5 }, (_, ch) => { const a = new AnalyserNode(ctx, { fftSize: 256 }); splitter.connect(a, ch); a.connect(mute); return a; }); mute.connect(ctx.destination); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .15, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('AudioContext did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      return analysers.map(a => {
        const x = new Float32Array(256); a.getFloatTimeDomainData(x);
        const mean = x.reduce((s, v) => s + v, 0) / 256;
        const bin = k => { let re = 0, im = 0; for (let n = 0; n < 256; n++) { const p = 2 * Math.PI * k * n / 256; re += x[n] * Math.cos(p); im -= x[n] * Math.sin(p); } return 2 * Math.hypot(re, im) / 256; };
        return { mean, peak: Math.max(...x.map(Math.abs)), variance: x.reduce((s, v) => s + (v - mean) ** 2, 0) / 256, finite: x.every(Number.isFinite), bin4: bin(4), bin8: bin(8) };
      });
    };
    const missing = await read(); node.events.load.emit({ data: Float32Array.from({ length: 64 }, (_, n) => .25 + .125 * Math.sin(2 * Math.PI * n / 64)) });
    const loaded = await read(), saved = await node.snapshot(); node.params.frequency.value = 1500; const edited = await read();
    node.events.load.emit({ data: new Float32Array([-.5]) }); const short = await read();
    const restored = await node.restore(saved), recovered = await read(); node.params.reset.value = 1; const reset = await read();
    return { sampleRate: ctx.sampleRate, missing, loaded, edited, short, restored, recovered, reset, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
