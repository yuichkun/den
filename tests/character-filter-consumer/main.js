import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runCharacterFilter = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const source = new ConstantSourceNode(ctx, { offset: .25 });
  const oscillator = new OscillatorNode(ctx, { frequency: 997 });
  const inputGain = new GainNode(ctx, { gain: 0 });
  const errors = []; let node;
  try {
    node = await createNode(ctx, processor);
    node.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
    const analyser = new AnalyserNode(ctx, { fftSize: 2048 }), mute = new GainNode(ctx, { gain: 0 });
    source.connect(node.inputs.main); oscillator.connect(inputGain); inputGain.connect(node.inputs.main);
    node.outputs.main.connect(analyser); analyser.connect(mute); mute.connect(ctx.destination);
    source.start(); oscillator.start(); await ctx.resume();
    const read = async (delay = .3) => {
      const end = ctx.currentTime + delay, deadline = performance.now() + 10000;
      while (ctx.currentTime < end) { if (performance.now() > deadline) throw new Error('AudioContext did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
      const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples);
      return { peak: Math.max(...samples.map(Math.abs)), mean: samples.reduce((a, b) => a + b, 0) / samples.length,
        rms: Math.sqrt(samples.reduce((a, b) => a + b * b, 0) / samples.length), finite: samples.every(Number.isFinite) };
    };
    const driven = await read(); node.params.drive.value = 2; const lowerDrive = await read();
    node.params.resonance.value = 0; const lowerResonance = await read();
    source.offset.value = 0; inputGain.gain.value = .2; node.params.drive.value = 1;
    node.params.poleHz.value = 50; const lowPole = await read(.6);
    node.params.poleHz.value = 5000; const highPole = await read();
    inputGain.gain.value = 0; source.offset.value = .25;
    node.params.poleHz.value = 20; node.params.resonance.value = 1; node.params.drive.value = 8;
    const history = await read(1); const snapshot = await node.snapshot();
    source.offset.value = 0; node.params.reset.value = 1; const cleared = await read();
    node.params.reset.value = 0; const beforeRestore = await read(.1);
    const restored = await node.restore(snapshot); const afterRestore = await read(.12);
    return { sampleRate: ctx.sampleRate, driven, lowerDrive, lowerResonance, lowPole, highPole, history, cleared, beforeRestore, restored, afterRestore, errors };
  } finally { try { source.stop(); oscillator.stop(); } catch {} node?.dispose(); await ctx.close(); }
};
