import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runFilterBankVocoder = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = [], sources = [];
  let node;
  try {
    node = await createNode(ctx, processor); node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    const modulator = new OscillatorNode(ctx, { frequency: 1000 }), carrier = new OscillatorNode(ctx, { frequency: 1000 });
    modulator.connect(merge, 0, 0); carrier.connect(merge, 0, 1); sources.push(modulator, carrier);
    merge.connect(node.inputs.main);
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 7 }), mute = new GainNode(ctx, { gain: 0 });
    node.outputs.main.connect(split);
    const meters = Array.from({length: 7}, (_, ch) => { const meter = new AnalyserNode(ctx, { fftSize: 2048 }); split.connect(meter, ch); meter.connect(mute); return meter; });
    mute.connect(ctx.destination); sources.forEach(source => source.start()); await ctx.resume();
    const read = async () => {
      const until = ctx.currentTime + .3, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('Native audio clock did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await ctx.suspend();
      try {
        const at = ctx.currentTime;
        return meters.map(meter => { const samples = new Float32Array(2048); meter.getFloatTimeDomainData(samples); return { at, finite: samples.every(Number.isFinite), peak: Math.max(...samples.map(Math.abs)), rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length), mean: samples.reduce((sum, x) => sum + x, 0) / samples.length }; });
      } finally { await ctx.resume(); }
    };
    const active = await read();
    node.params.modulatorGain.value = 2; const doubled = await read();
    node.params.carrierGain.value = 0; const carrierSilent = await read();
    // Save a nonzero envelope after analysis ringing has drained. Stable zero
    // modulator input cannot rebuild this state during pre-restore coordination.
    node.params.modulatorGain.value = 0; node.params.carrierGain.value = 1; node.params.release.value = 30;
    const beforeSave = await read(), snapshotBefore = ctx.currentTime;
    const snapshot = await node.snapshot(), snapshotAfter = ctx.currentTime;
    node.params.carrierGain.value = 0; node.params.reset.value = 1; const mutated = await read();
    node.params.carrierGain.value = 1; node.params.reset.value = 0; const controlsPrepared = await read();
    const restoreBefore = ctx.currentTime, restored = await node.restore(snapshot), restoreAfter = ctx.currentTime;
    const afterRestore = await read();
    node.params.carrierGain.value = 0; node.params.reset.value = 1;
    const cleared = await read();
    return { sampleRate: ctx.sampleRate, active, doubled, carrierSilent, beforeSave, snapshotBefore, snapshotAfter, mutated, controlsPrepared, restoreBefore, restored, restoreAfter, afterRestore, cleared, errors };
  } finally { sources.forEach(source => { try { source.stop(); } catch {} }); node?.dispose(); await ctx.close(); }
};
