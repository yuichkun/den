import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';

window.runSpatial = async () => {
  const context = new AudioContext({ sampleRate: 48000 }), errors = [];
  let node;
  try {
    node = await createNode(context, processor);
    node.onError(e => errors.push({ code: e.code, message: String(e.message ?? '') }));
    const split = new ChannelSplitterNode(context, { numberOfOutputs: 19 }), mute = new GainNode(context, { gain: 0 });
    node.outputs.main.connect(split); mute.connect(context.destination);
    const meters = Array.from({ length: 19 }, (_, ch) => {
      const analyser = new AnalyserNode(context, { fftSize: 2048 }); split.connect(analyser, ch); analyser.connect(mute); return analyser;
    });
    await context.resume();
    const read = async (seconds = .15) => {
      const until = context.currentTime + seconds, deadline = performance.now() + 15000;
      while (context.currentTime < until) {
        if (performance.now() > deadline) throw new Error('Native spatial clock did not advance');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await context.suspend();
      try {
        return meters.map((analyser, ch) => {
          const x = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(x);
          return { mean: x.reduce((sum, v) => sum + v, 0) / x.length, peak: Math.max(...x.map(Math.abs)),
            rms: Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length), finite: x.every(Number.isFinite),
            ...(ch < 8 ? { samples: Array.from(x) } : {}) };
        });
      } finally { await context.resume(); }
    };
    const set = values => { for (const [key, value] of Object.entries(values)) node.params[key].value = value; };
    const phases = {};
    phases.steady = await read(1.5);
    set({ mix: 0 }); phases.dry = await read();
    set({ mix: 1, pitchMix: 0 }); phases.unpitched = await read();
    set({ pitchMix: 1 }); phases.unityLate = await read();
    set({ ratio: 2 }); phases.octave = await read();
    set({ ratio: .5 }); phases.half = await read();
    set({ ratio: 1, retrigger: 1 }); phases.rephase = await read();
    set({ retrigger: 0, pitchMix: .5 }); phases.restoredUnity = await read();
    set({ bypass: 1 }); phases.bypass = await read();
    set({ bypass: 0, level: 0 }); phases.beforeSave = await read(.1);
    const saved = await node.snapshot();
    set({ disturb: 1 }); phases.mutated = await read(.15);
    // Saved input/controls are rendered before restore. Unequal decaying
    // histories must remain; no reset can erase the pre-restore difference.
    set({ disturb: 0 }); phases.controlsPrepared = await read(.1);
    const restored = await node.restore(saved); phases.afterRestore = await read(.1);
    set({ level: .25, reset: 1, bypass: 1 }); phases.resetBypass = await read();
    set({ reset: 0 }); phases.bypassAfterReset = await read();
    set({ level: 0, bypass: 0 }); phases.empty = await read();
    return { sampleRate: context.sampleRate, phases, restored, errors };
  } finally { node?.dispose(); await context.close(); }
};
