import { createNode, inspect } from '@unworklet/core';
import processor from './processor.ts?worklet';
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

// Test-only downstream capture via the browser's native ScriptProcessorNode.
// No custom worklet/loader is introduced. Capture input beside both rendered
// outputs so a missed render, repeated quantum, or periodic reset is observable.
window.runSustainedFx = async (nativeOnly = false) => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  const fx = nativeOnly ? null : await createNode(context, processor, { initial: { timeLeft: 0.075, timeRight: 0.1, feedback: 0.95 } });
  const oscillator = new OscillatorNode(context, { type: 'sine', frequency: 220 });
  const source = new GainNode(context, { gain: 0.05 });
  const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 3 });
  // Leave main-thread delivery headroom; a smaller buffer also dropped source
  // samples in the native-only baseline. All captured samples remain checked.
  const capture = context.createScriptProcessor(8192, 3, 1);
  oscillator.connect(source); source.connect(merger, 0, 0);
  if (fx) {
    source.connect(fx.inputs.main); fx.outputs.main.connect(splitter);
    splitter.connect(merger, 0, 1); splitter.connect(merger, 1, 2);
  } else { source.connect(merger, 0, 1); source.connect(merger, 0, 2); }
  merger.connect(capture); capture.connect(context.destination);
  const channels = Array.from({ length: 3 }, () => new Float32Array(2 ** 19));
  const playbackTimes = [], callbackTimes = [], errors = [];
  fx?.onError(error => errors.push({ ...error, message: String(error.message ?? '') }));
  let frames = 0;
  const done = new Promise(resolve => {
    capture.onaudioprocess = event => {
      event.outputBuffer.getChannelData(0).fill(0); // Silent capture.
      if (frames >= 2 ** 19) return;
      playbackTimes.push(event.playbackTime); callbackTimes.push(performance.now());
      for (let ch = 0; ch < 3; ch++) channels[ch].set(event.inputBuffer.getChannelData(ch), frames);
      frames += event.inputBuffer.length;
      if (frames >= 2 ** 19) resolve();
    };
  });
  const start = context.currentTime + 0.15;
  oscillator.start(start); oscillator.stop(start + 4);
  try {
    await context.resume();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('continuous browser capture timed out')), 30000))]);
    await context.suspend();
    return { sampleRate: context.sampleRate, channels: channels.map(x => Array.from(x)), playbackTimes, callbackTimes, errors, frames,
      captureBlockFrames: 8192, nativeOnly, transport: fx?.diagnostics.transport ?? 'native', settings: { timeLeft: Math.fround(0.075), timeRight: Math.fround(0.1), feedback: Math.fround(0.95), cutoff: 1000, mix: 1, rate: 0, depth: 0 },
      source: { frequency: 220, gain: 0.05, durationSeconds: 4 }, capture: 'native ScriptProcessorNode, 8192 frames, input/L/R' };
  } finally { capture.onaudioprocess = null; capture.disconnect(); fx?.dispose(); await context.close(); }
};
