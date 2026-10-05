import './wave-main.js';
import './performance-main.js';
import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runMaterials = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor);
    node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 7 }), mute = new GainNode(ctx, { gain: 0 });
    node.outputs.main.connect(splitter);
    const analysers = Array.from({ length: 7 }, (_, ch) => { const a = new AnalyserNode(ctx, { fftSize: 256 }); splitter.connect(a, ch); a.connect(mute); return a; });
    mute.connect(ctx.destination); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .15, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('AudioContext did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      return analysers.map(a => { const x = new Float32Array(256); a.getFloatTimeDomainData(x); return { mean: x.reduce((s, v) => s + v, 0) / 256, rms: Math.sqrt(x.reduce((s, v) => s + v * v, 0) / 256), peak: Math.max(...x.map(Math.abs)), finite: x.every(Number.isFinite), samples: Array.from(x) }; });
    };
    const replace = async pcm => { node.params.gate.value = 0; await read(); node.events.load.emit({ data: pcm }); const loaded = await read(); node.params.gate.value = 1; const playing = await read(); return { loaded, playing }; };
    const unloaded = await read(), first = await replace(Float32Array.from({ length: 64 }, (_, n) => .25 + .125 * Math.sin(2 * Math.PI * n / 64))), saved = await node.snapshot();
    const short = await replace(new Float32Array([-.125]));
    const empty = await replace(new Float32Array(0));
    const restored = await node.restore(saved), recovered = await read();
    node.params.reset.value = 1; const reset = await read();
    return { sampleRate: ctx.sampleRate, unloaded, first, short, empty, restored, recovered, reset, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
