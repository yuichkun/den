import { createNode, inspect } from '@unworklet/core';
import processor from './processor.js?worklet';
window.runGate = async (sampleRate) => {
  const ctx = new AudioContext({sampleRate});
  await ctx.suspend();
  let node;
  try {
    node = await createNode(ctx, processor, {initial: {gain: 0.5}});
  } catch (error) {
    const failure = {status:'blocked', requestedSampleRate:sampleRate, actualSampleRate:ctx.sampleRate, error:String(error)};
    await ctx.close();
    return failure;
  }
  const initial = inspect(await node.snapshot());
  const source = new ConstantSourceNode(ctx, {offset: 1});
  const analyser = new AnalyserNode(ctx, {fftSize: 256});
  const mute = new GainNode(ctx, {gain: 0});
  source.connect(node.inputs.main);
  node.outputs.main.connect(analyser);
  analyser.connect(mute).connect(ctx.destination);
  source.start();
  const settle = async () => {
    const until = ctx.currentTime + 0.1;
    await ctx.resume();
    while (ctx.currentTime < until) await new Promise(r => setTimeout(r, 10));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    await ctx.suspend();
    return Array.from(data);
  };
  try {
    const before = await settle();
    const saved = await node.snapshot();
    node.params.gain.value = 0.25;
    const suspended = inspect(await node.snapshot());
    const changed = await settle();
    const restored = await node.restore(saved);
    const after = await settle();
    return {status:'rendered', requestedSampleRate:sampleRate, actualSampleRate:ctx.sampleRate, initial, suspended, saved: inspect(saved), restored, before, changed, after};
  } finally { source.stop(); node.dispose(); await ctx.close(); }
};
