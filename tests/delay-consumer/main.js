import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runDelay = async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  const cell = await createNode(context, processor);
  const source = new ConstantSourceNode(context, { offset: 0.75 });
  const analyser = new AnalyserNode(context, { fftSize: 256 });
  const mute = new GainNode(context, { gain: 0 });
  source.connect(cell.inputs.main);
  cell.outputs.main.connect(analyser);
  analyser.connect(mute).connect(context.destination);
  source.start();
  const capture = async () => {
    const until = context.currentTime + 0.1;
    await context.resume();
    while (context.currentTime < until) await new Promise(r => setTimeout(r, 10));
    const samples = new Float32Array(256);
    analyser.getFloatTimeDomainData(samples);
    await context.suspend();
    return Array.from(samples);
  };
  try {
    const initial = await capture();
    cell.params.reset.value = 1;
    const cleared = await capture();
    cell.params.reset.value = 0;
    cell.params.delay.value = 10.5 / context.sampleRate;
    const resumed = await capture();
    return { sampleRate: context.sampleRate, initial, cleared, resumed };
  } finally {
    source.stop(); cell.dispose(); await context.close();
  }
};
