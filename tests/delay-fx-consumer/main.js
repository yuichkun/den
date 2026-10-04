import { createNode, inspect, decodeSnapshot } from '@unworklet/core';
import processor from './processor.ts?worklet';
import captureProcessor from './capture.ts?worklet';
window.runFx = async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  const fx = await createNode(context, processor);
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  const analyser = new AnalyserNode(context, { fftSize: 256 });
  const mute = new GainNode(context, { gain: 0 });
  source.connect(fx.inputs.main); fx.outputs.main.connect(analyser);
  analyser.connect(mute).connect(context.destination); source.start();
  const capture = async () => {
    const until = context.currentTime + 0.25;
    await context.resume();
    while (context.currentTime < until) await new Promise(r => setTimeout(r, 10));
    const samples = new Float32Array(256); analyser.getFloatTimeDomainData(samples);
    await context.suspend(); return Array.from(samples);
  };
  try {
    const initial = await capture();
    const saved = await fx.snapshot();
    fx.params.mix.value = 0;
    const dry = await capture();
    fx.params.mix.value = 1; fx.params.bypass.value = 1;
    const bypass = await capture();
    fx.params.bypass.value = 0; fx.params.reset.value = 1;
    const cleared = await capture();
    fx.params.reset.value = 0;
    const resumed = await capture();
    fx.params.sync.value = 1;
    const invalid = await capture();
    const timingRejected = inspect(await fx.snapshot()).slots.timingRejected.value;
    const restored = await fx.restore(saved);
    const after = await capture();
    return { sampleRate: context.sampleRate, initial, dry, bypass, cleared, resumed, invalid, timingRejected, restored, after };
  } finally { source.stop(); fx.dispose(); await context.close(); }
};

// Test-only downstream capture via existing unworklet buffers and snapshots.
// No ScriptProcessor callbacks occur while recording the audio graph.
window.runSustainedFx = async (nativeOnly = false) => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  const fx = nativeOnly ? null : await createNode(context, processor, { initial: { timeLeft: 0.075, timeRight: 0.1, feedback: 0.95 } });
  const recorder = await createNode(context, captureProcessor);
  const oscillator = new OscillatorNode(context, { type: 'sine', frequency: 220 });
  const source = new GainNode(context, { gain: 0.05 });
  const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 3 });
  oscillator.connect(source); source.connect(merger, 0, 0);
  if (fx) {
    source.connect(fx.inputs.main); fx.outputs.main.connect(splitter);
    splitter.connect(merger, 0, 1); splitter.connect(merger, 1, 2);
  } else { source.connect(merger, 0, 1); source.connect(merger, 0, 2); }
  merger.connect(recorder.inputs.main); recorder.outputs.main.connect(context.destination);
  const errors = [];
  fx?.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
  recorder.onError(error => errors.push({ ...error, source: 'recorder', message: String(error.message ?? '') }));
  const frames = 2 ** 19, start = context.currentTime + 0.15, durationSeconds = nativeOnly ? 10 : 4;
  oscillator.start(start); oscillator.stop(start + durationSeconds);
  try {
    await context.resume();
    const deadline = performance.now() + 30000;
    while (context.currentTime < start + frames / 48000) {
      if (performance.now() > deadline) throw new Error('continuous browser capture timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await context.suspend();
    // Snapshot and serialize only after rendering has stopped.
    const snapshot = await recorder.snapshot(), decoded = decodeSnapshot(snapshot);
    const channels = ['input', 'left', 'right'].map(name => {
      const slot = decoded.slots.find(slot => slot.name === name && slot.kind === 'buffer');
      if (!slot) throw new Error(`Missing recorded channel ${name}`);
      return Array.from(new Float32Array(slot.data.slice().buffer).subarray(0, frames));
    });
    return { sampleRate: context.sampleRate, channels, errors, frames,
      processedFrames: inspect(snapshot).slots.frames.value,
      nativeOnly, transport: fx?.diagnostics.transport ?? 'native', settings: { timeLeft: Math.fround(0.075), timeRight: Math.fround(0.1), feedback: Math.fround(0.95), cutoff: 1000, mix: 1, rate: 0, depth: 0 },
      source: { frequency: 220, gain: 0.05, durationSeconds }, capture: 'downstream unworklet fixed buffers, input/L/R' };
  } finally { recorder.dispose(); fx?.dispose(); await context.close(); }
};
