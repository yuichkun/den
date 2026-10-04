import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runInstrument = async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  const node = await createNode(context, processor, { initial: {
    gain: 0.2, ampAttack: 0, ampDecay: 0, ampSustain: 1, ampRelease: 0.05,
    pitchEnvelopeDepth: 0, filterEnvelopeDepth: 0, cutoff: 1000, resonance: 0.707,
  } });
  const analyser = new AnalyserNode(context, { fftSize: 2048 });
  const mute = new GainNode(context, { gain: 0 });
  node.outputs.main.connect(analyser); analyser.connect(mute).connect(context.destination);
  const capture = async () => {
    const until = context.currentTime + 0.2;
    await context.resume();
    while (context.currentTime < until) await new Promise(r => setTimeout(r, 10));
    const audio = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(audio);
    await context.suspend();
    return { rms: Math.sqrt(audio.reduce((s,x) => s+x*x,0)/audio.length), peak: Math.max(...audio.map(Math.abs)), finite: audio.every(Number.isFinite) };
  };
  const on = () => node.midi.midi.send({type:'noteOn',note:69,velocity:127,channel:0});
  const off = () => node.midi.midi.send({type:'noteOff',note:69,velocity:0,channel:0});
  try {
    const silent = await capture();
    on(); const single = await capture();
    node.params.gain.value = 0.1; const changed = await capture();
    node.params.cutoff.value = 100; const filtered = await capture();
    node.params.cutoff.value = 1000; node.params.gain.value = 0.2;
    node.params.bypass.value = 1; const bypassed = await capture();
    node.params.bypass.value = 0; const resumed = await capture();
    node.events.reset.emit({value:1}); const reset = await capture();
    on(); on(); const chord = await capture();
    off(); const oneRelease = await capture();
    off(); const ended = await capture();
    on(); const restarted = await capture();
    node.params.bypass.value = 1; await capture(); off(); await capture();
    node.params.bypass.value = 0; const endedWhileBypassed = await capture();
    return {sampleRate:context.sampleRate,silent,single,changed,filtered,bypassed,resumed,reset,chord,oneRelease,ended,restarted,endedWhileBypassed};
  } finally { node.dispose(); await context.close(); }
};
