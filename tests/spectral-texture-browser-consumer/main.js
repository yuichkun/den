import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';

window.runSpectralTexture = async () => {
  const context = new AudioContext({ sampleRate: 48000 }), errors = [];
  let node;
  try {
    node = await createNode(context, processor);
    node.onError(e => errors.push({ code: e.code, message: String(e.message ?? '') }));
    const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 12 });
    const mute = new GainNode(context, { gain: 0 });
    node.outputs.main.connect(splitter); mute.connect(context.destination);
    const analysers = Array.from({ length: 12 }, (_, channel) => {
      const analyser = new AnalyserNode(context, { fftSize: 2048 });
      splitter.connect(analyser, channel); analyser.connect(mute); return analyser;
    });
    await context.resume();
    const read = async () => {
      const until = context.currentTime + .1, deadline = performance.now() + 10000;
      while (context.currentTime < until) {
        if (performance.now() > deadline) throw new Error('Native spectral clock did not advance');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await context.suspend();
      try {
        return analysers.map((analyser, channel) => {
          const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
          return { finite: samples.every(Number.isFinite), mean: samples.reduce((sum, v) => sum + v, 0) / samples.length,
            peak: Math.max(...samples.map(Math.abs)), ...(channel < 5 ? { samples: Array.from(samples) } : {}) };
        });
      } finally { await context.resume(); }
    };
    const set = values => { for (const [name, value] of Object.entries(values)) node.params[name].value = value; };
    const phases = {};
    phases.identity = await read();
    set({ amount: 1 }); phases.full = await read();
    set({ amount: .5 }); phases.half = await read();
    set({ amount: 1, samePattern: 1 }); phases.sameInput = await read();
    set({ carrierLevel: .125 }); phases.capped = await read();
    set({ modulatorLevel: 0 }); phases.silentModulator = await read();
    set({ carrierLevel: 0, modulatorLevel: 1 }); phases.silentCarrier = await read();
    set({ amount: .75, carrierLevel: .5, modulatorLevel: 1, samePattern: 0, reset: 0, flip: 0 });
    phases.beforeSave = await read(); const saved = await node.snapshot();
    set({ flip: 1 }); phases.mutated = await read();
    // Every saved control renders while the persistent negative source remains.
    // Core0.4.1 native state/AudioParam restoration is not atomic.
    set({ flip: 0 }); phases.controlsPrepared = await read();
    const restored = await node.restore(saved); phases.afterRestore = await read();
    set({ reset: 1 }); phases.reset = await read();
    set({ reset: 0 }); phases.restarted = await read();
    return { sampleRate: context.sampleRate, phases, restored, errors };
  } finally { node?.dispose(); await context.close(); }
};
