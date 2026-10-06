import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runLiveGranular = async () => {
  const ctx = new AudioContext({ sampleRate: 48000 }), errors = []; let node;
  try {
    node = await createNode(ctx, processor); node.onError(e => errors.push({ code: e.code, message: String(e.message ?? '') }));
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 20 }), mute = new GainNode(ctx, { gain: 0 }); node.outputs.main.connect(splitter); mute.connect(ctx.destination);
    const meters = Array.from({ length: 20 }, (_, ch) => { const meter = new AnalyserNode(ctx, { fftSize: 2048 }); splitter.connect(meter, ch); meter.connect(mute); return meter; });
    const set = values => { for (const [name, value] of Object.entries(values)) node.params[name].value = value; };
    const read = async () => {
      const until = ctx.currentTime + .1, deadline = performance.now() + 10000;
      while (ctx.currentTime < until) { if (performance.now() > deadline) throw new Error('Native clock did not advance'); await new Promise(r => setTimeout(r, 10)); }
      await ctx.suspend();
      try { return meters.map((meter, ch) => { const x = new Float32Array(2048); meter.getFloatTimeDomainData(x); return { finite: x.every(Number.isFinite), mean: x.reduce((a, b) => a + b, 0) / x.length, minimum: Math.min(...x), maximum: Math.max(...x), ...([0,6].includes(ch) ? { samples: Array.from(x) } : {}) }; }); }
      finally { await ctx.resume(); }
    };
    await ctx.resume(); const result = { sampleRate: ctx.sampleRate };
    result.initial = await read(); set({ record: 1 }); result.filled = await read();
    set({ record: 0 }); result.paused = await read();
    set({ trigger: 1 }); result.active = await read();
    set({ trigger: 0, age: 0, rate: 1, duration: 0 }); result.latchedEdits = await read();
    set({ age: 4, rate: 0, duration: 2 }); result.beforeSave = await read(); const saved = await node.snapshot();
    set({ reset: 1 }); result.cleared = await read();
    set({ base: -.75, reset: 0 }); result.negativePrepared = await read();
    set({ record: 1 }); result.negativeFilled = await read();
    set({ record: 0 }); result.negativePaused = await read();
    set({ trigger: 1 }); result.negativeActive = await read();
    set({ trigger: 0, base: .25 }); result.controlsPrepared = await read();
    result.restored = await node.restore(saved); result.afterRestore = await read();
    // Prepare a larger writer limit while recording remains off, then change
    // only the record control. The old source identity will be overwritten.
    set({ limit: 128 }); result.expiryPrepared = await read();
    set({ record: 1 }); result.expired = await read();
    set({ record: 0 }); result.expiredPaused = await read();
    set({ reset: 1 }); result.heldReset = await read();
    set({ reset: 0 }); result.emptyPrepared = await read();
    set({ trigger: 1 }); result.emptyRejected = await read();
    return { ...result, errors };
  } finally { node?.dispose(); await ctx.close(); }
};
