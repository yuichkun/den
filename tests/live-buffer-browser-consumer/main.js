import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runLiveBuffer = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor); node.onError(e => errors.push({ code: e.code, message: String(e.message ?? '') }));
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 18 }), mute = new GainNode(ctx, { gain: 0 });
    node.outputs.main.connect(split); mute.connect(ctx.destination);
    const meters = Array.from({ length: 18 }, (_, channel) => { const meter = new AnalyserNode(ctx, { fftSize: 2048 }); split.connect(meter, channel); meter.connect(mute); return meter; });
    const set = values => { for (const [name, value] of Object.entries(values)) node.params[name].value = value; };
    const read = async () => {
      const until = ctx.currentTime + .1, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('Native clock did not advance'); await new Promise(r => setTimeout(r, 10)); }
      await ctx.suspend();
      try { return meters.map(meter => { const x = new Float32Array(2048); meter.getFloatTimeDomainData(x); return { finite: x.every(Number.isFinite), mean: x.reduce((a, b) => a + b, 0) / x.length, minimum: Math.min(...x), maximum: Math.max(...x) }; }); }
      finally { await ctx.resume(); }
    };
    await ctx.resume(); const result = { sampleRate: ctx.sampleRate };
    result.initial = await read();
    set({ record: 1 }); result.partial = await read();
    set({ record: 0, age: .5 }); result.fractional = await read();
    set({ age: 3 }); result.expired = await read();
    set({ age: 0, limit: 20 }); result.writePrepared = await read();
    set({ record: 1 }); result.wrapped = await read();
    set({ record: 0, age: .5 }); result.beforeSave = await read(); const saved = await node.snapshot();
    set({ reset: 1, base: -.5, limit: 4, record: 1 }); result.heldClear = await read();
    set({ reset: 0 }); result.mutated = await read();
    // Pause first; the restored controls must leave the short negative history
    // intact, rather than rebuilding or resetting the saved positive history.
    set({ record: 0 }); result.pausedMutation = await read();
    set({ reset: 0, age: .5, limit: 20, base: .25 }); result.controlsPrepared = await read();
    result.restored = await node.restore(saved); result.afterRestore = await read();
    result.restoredAges = [];
    for (let age = 0; age < 8; age++) { set({ age }); result.restoredAges.push(await read()); }
    set({ age: 0, limit: 21 }); result.continuePrepared = await read();
    set({ record: 1 }); result.continued = await read();
    set({ reset: 1, limit: 2 }); result.heldReset = await read();
    set({ reset: 0 }); result.resetReleased = await read();
    return { ...result, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
