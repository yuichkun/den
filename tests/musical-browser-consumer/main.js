import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runMusical = async () => {
  const context = new AudioContext({ sampleRate: 48000 }), errors = [];
  let node;
  try {
    node = await createNode(context, processor);
    node.onError(e => errors.push({ code: e.code, message: String(e.message ?? '') }));
    const split = new ChannelSplitterNode(context, { numberOfOutputs: 23 }), mute = new GainNode(context, { gain: 0 });
    node.outputs.main.connect(split); mute.connect(context.destination);
    const meters = Array.from({ length: 23 }, (_, ch) => {
      const analyser = new AnalyserNode(context, { fftSize: 2048 }); split.connect(analyser, ch); analyser.connect(mute); return analyser;
    });
    await context.resume();
    const read = async (seconds = .12) => {
      const until = context.currentTime + seconds, deadline = performance.now() + 15000;
      while (context.currentTime < until) {
        if (performance.now() > deadline) throw new Error('Native musical clock did not advance');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await context.suspend();
      try { return meters.map(analyser => {
        const x = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(x);
        return { mean: x.reduce((s, v) => s + v, 0) / x.length, peak: Math.max(...x.map(Math.abs)), finite: x.every(Number.isFinite), samples: Array.from(x) };
      }); } finally { await context.resume(); }
    };
    const set = values => { for (const [key, value] of Object.entries(values)) node.params[key].value = value; };
    const phases = {};
    phases.steady = await read();
    set({ bend: -.75, rate: 6.25, bpm: 180 }); phases.edited = await read();
    set({ bend: 0 }); phases.linear = await read();
    set({ hold: 1, seek: 0, position: .375, offset: .125 }); phases.prepareSavedSeek = await read();
    set({ seek: 1 }); await read();
    set({ seek: 0 }); phases.beforeSave = await read();
    const saved = await node.snapshot();
    set({ position: -.25 }); phases.prepareMutatedSeek = await read();
    set({ seek: 1 }); await read();
    set({ seek: 0 }); phases.mutated = await read();
    set({ position: .375 }); phases.controlsPrepared = await read();
    const restored = await node.restore(saved); phases.afterRestore = await read();
    set({ position: -(2 ** -60), offset: 0 }); phases.prepareTinySeek = await read();
    set({ seek: 1 }); phases.tinyNegative = await read();
    set({ seek: 0 }); phases.tinyHeld = await read();
    set({ reset: 1, offset: .125 }); phases.reset = await read();
    set({ reset: 0, hold: 0, offset: 0 }); phases.resumed = await read();
    return { sampleRate: context.sampleRate, phases, restored, errors };
  } finally { node?.dispose(); await context.close(); }
};
