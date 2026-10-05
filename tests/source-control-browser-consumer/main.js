import { createNode } from '@unworklet/core';
import sourceProcessor from './source-processor.ts?worklet';
import controlProcessor from './control-processor.ts?worklet';

async function exercise(processor, scenario) {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor);
    node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 7 }), mute = new GainNode(ctx, { gain: 0 });
    node.outputs.main.connect(splitter);
    const analysers = Array.from({ length: 7 }, (_, channel) => {
      const a = new AnalyserNode(ctx, { fftSize: 256 }); splitter.connect(a, channel); a.connect(mute); return a;
    });
    mute.connect(ctx.destination); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .15, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) {
        if (performance.now() > deadline) throw new Error('AudioContext did not advance');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return analysers.map(a => {
        const x = new Float32Array(256); a.getFloatTimeDomainData(x);
        const bin = k => { let real = 0, imaginary = 0; for (let n = 0; n < 256; n++) { const angle = 2 * Math.PI * k * n / 256; real += x[n] * Math.cos(angle); imaginary -= x[n] * Math.sin(angle); } return 2 * Math.hypot(real, imaginary) / 256; };
        return { mean: x.reduce((s, v) => s + v, 0) / 256, rms: Math.sqrt(x.reduce((s, v) => s + v * v, 0) / 256), peak: Math.max(...x.map(Math.abs)), finite: x.every(Number.isFinite), bin2: bin(2), bin4: bin(4) };
      });
    };
    return { sampleRate: ctx.sampleRate, ...await scenario(node, read), errors };
  } finally { node?.dispose(); await ctx.close(); }
}
window.runSources = () => exercise(sourceProcessor, async (node, read) => {
  const initial = await read(), saved = await node.snapshot();
  node.params.frequency.value = 750; const edited = await read();
  const restored = await node.restore(saved), afterRestore = await read();
  // Freeze nonzero oscillator phases, then prove a restore differs from restart.
  let held;
  for (let attempt = 0; attempt < 3; attempt++) {
    node.params.frequency.value = 1; await read(); node.params.frequency.value = 0; held = await read();
    if (Math.abs(held[0].mean) > .1) break;
  }
  const history = await node.snapshot();
  node.params.reset.value = 1; const cleared = await read();
  node.params.reset.value = 0; const restarted = await read();
  const historyRestored = await node.restore(history), recovered = await read();
  node.params.reset.value = 1; const reset = await read();
  return { initial, edited, restored, afterRestore, held, cleared, restarted, historyRestored, recovered, reset };
});
window.runControls = () => exercise(controlProcessor, async (node, read) => {
  const initial = await read();
  node.params.input.value = .75; node.params.position.value = 2.5; node.params.trigger.value = 1;
  await read(); node.params.seek.value = 1; const prepared = await read(), saved = await node.snapshot();
  node.params.seek.value = 0; node.params.input.value = -.5; node.params.position.value = 1.25; node.params.trigger.value = 0;
  await read(); node.params.seek.value = 1; node.params.trigger.value = 1; const edited = await read();
  const restored = await node.restore(saved), afterRestore = await read();
  node.params.reset.value = 1; const reset = await read();
  return { initial, prepared, edited, restored, afterRestore, reset };
});
