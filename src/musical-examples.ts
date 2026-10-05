import {
  audioInput, audioOutput, bool, CAPACITY_16, defineProcessor, event, f32,
  forSample, instantiate, param, select, state,
} from '@unworklet/core';
import { envelope } from './envelope.js';
import { residentSample, granularSource } from './sample.js';
import { wavetableSource } from './wavetable.js';
import { frequencyModulation } from './source.js';
import { modalResonator } from './resonator.js';
import { drive } from './drive.js';
import { stateVariableFilter } from './state-variable-filter.js';
import { pingPongDelay } from './stereo-delay.js';
import {
  glassDyadParameters as glass, fmModalHitParameters as hit,
  grainCloudParameters as grain, shapedEchoParameters as echo, fmModalHitModes,
} from './musical-materials.js';
export {
  musicalMaterialsStatus, glassDyadParameters, glassDyadBrightParameters, glassDyadConstruction, makeGlassDyadTable,
  fmModalHitParameters, fmModalHitBellParameters, fmModalHitModes,
  grainCloudParameters, grainCloudReverseParameters, grainCloudConstruction, makeGrainCloudSample,
  shapedEchoParameters, shapedEchoDarkParameters,
} from './musical-materials.js';

/** CANDIDATE fixed two-voice instrument. Independent native gate/frequency params,
 * shared resident morph table and ordinary native snapshot state; no MIDI allocator.
 * Send `load` with makeGlassDyadTable() before gate-on. Output `main` is stereo.
 */
export const glassDyad = defineProcessor(({ sampleRate }) => {
  const asset = instantiate(residentSample, { capacity: 384, sourceSampleRate: 48000 }, { name: 'asset' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 1536 })
    .onReceive(({ data }) => asset.load(data));
  const gateA = param.f32({ default: glass.gateA, min: 0, max: 1, automationRate: 'a-rate' }).named('gateA');
  const gateB = param.f32({ default: glass.gateB, min: 0, max: 1, automationRate: 'a-rate' }).named('gateB');
  const frequencyA = param.f32({ default: glass.frequencyA, min: 55, max: 1200, automationRate: 'a-rate' }).named('frequencyA');
  const frequencyB = param.f32({ default: glass.frequencyB, min: 55, max: 1200, automationRate: 'a-rate' }).named('frequencyB');
  const frame = param.f32({ default: glass.frame, min: 0, max: 2, automationRate: 'a-rate' }).named('frame');
  const gain = param.f32({ default: glass.gain, min: 0, max: .3, automationRate: 'a-rate' }).named('gain');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const voices = [0, 1].map(n => ({
    wave: instantiate(wavetableSource, { sampleRate, sample: asset, frameLength: 128, frameCount: 3 }, { name: `wave${n}` }),
    amp: instantiate(envelope, { sampleRate }, { name: `amp${n}` }),
    gate: state.bool(false).named(`previousGate${n}`),
  }));
  const out = audioOutput({ channels: 2, name: 'main' });
  return { process() { forSample(i => {
    const clear = reset.at(i).gte(.5);
    const values = voices.map((v, n) => {
      const gate = (n === 0 ? gateA : gateB).at(i).gte(.5), trigger = gate.and(v.gate.read().not());
      const amp = v.amp.tick({ gate, retrigger: bool(false), reset: clear,
        attack: f32(.012), decay: f32(.2), sustain: f32(.65), release: f32(.28) });
      const wave = v.wave.tick({ frequencyHz: (n === 0 ? frequencyA : frequencyB).at(i), frame: frame.at(i), reset: clear.or(trigger) });
      v.gate.write(gate);
      return select(clear, f32(0), wave.output.mul(amp.level));
    });
    out.ch(0).at(i).write(values[0].mul(.75).add(values[1].mul(.25)).mul(gain.at(i)));
    out.ch(1).at(i).write(values[0].mul(.25).add(values[1].mul(.75)).mul(gain.at(i)));
  }); } };
});

/** CANDIDATE fixed-pitch A3 struck voice. Gate rise excites one normalized modal
 * impulse and restarts FM/amp. Each new hit clears the old modal tail, keeping
 * its impulse bound; gate-off releases FM while the fixed modal tail continues.
 */
export const fmModalHit = defineProcessor(({ sampleRate }) => {
  const gate = param.f32({ default: hit.gate, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const strength = param.f32({ default: hit.strength, min: 0, max: 1, automationRate: 'a-rate' }).named('strength');
  const ratio = param.f32({ default: hit.ratio, min: .5, max: 4, automationRate: 'a-rate' }).named('ratio');
  const deviation = param.f32({ default: hit.deviationHz, min: 0, max: 180, automationRate: 'a-rate' }).named('deviationHz');
  const mix = param.f32({ default: hit.modalMix, min: 0, max: 1, automationRate: 'a-rate' }).named('modalMix');
  const gain = param.f32({ default: hit.gain, min: 0, max: .3, automationRate: 'a-rate' }).named('gain');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const previousGate = state.bool(false).named('previousGate');
  const velocity = state.f32(0).named('strength');
  const fm = instantiate(frequencyModulation, { sampleRate }, { name: 'fm' });
  const modes = instantiate(modalResonator, { sampleRate, modes: fmModalHitModes }, { name: 'modes' });
  const amp = instantiate(envelope, { sampleRate }, { name: 'amp' });
  const out = audioOutput({ channels: 2, name: 'main' });
  return { process() { forSample(i => {
    const on = gate.at(i).gte(.5), clear = reset.at(i).gte(.5);
    const strike = on.and(previousGate.read().not()).and(clear.not());
    velocity.write(select(clear, f32(0), select(strike, strength.at(i), velocity.read())));
    const a = amp.tick({ gate: on, retrigger: strike, reset: clear,
      attack: f32(.001), decay: f32(.18), sustain: f32(0), release: f32(.04) });
    const tone = fm.tick({ carrierHz: f32(220), modulatorHz: ratio.at(i).mul(220),
      deviationHz: deviation.at(i).mul(a.level), feedbackHz: f32(0), reset: clear.or(strike) });
    const ring = modes.tick(select(strike, velocity.read(), f32(0)), clear.or(strike));
    const m = mix.at(i);
    const value = select(clear, f32(0), tone.mul(a.level).mul(velocity.read()).mul(f32(1).sub(m)).add(ring.mul(m)).mul(gain.at(i)));
    out.ch(0).at(i).write(value); out.ch(1).at(i).write(value);
    previousGate.write(on);
  }); } };
});

/** CANDIDATE two-grain resident texture. `load` accepts makeGrainCloudSample().
 * Gate-off stops new grains and lets existing windows finish. Parameters latch
 * at each grain onset as specified by granularSource; no streaming or time stretch.
 */
export const grainCloud = defineProcessor(({ sampleRate }) => {
  const asset = instantiate(residentSample, { capacity: 4096, sourceSampleRate: 48000 }, { name: 'asset' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 16384 })
    .onReceive(({ data }) => asset.load(data));
  const source = instantiate(granularSource, { sampleRate, sample: asset, maxGrains: 2, seed: 1741, loop: true }, { name: 'grains' });
  const gate = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const position = param.f32({ default: grain.positionFrames, min: 0, max: 4095, automationRate: 'a-rate' }).named('positionFrames');
  const jitter = param.f32({ default: grain.jitterFrames, min: 0, max: 4095, automationRate: 'a-rate' }).named('jitterFrames');
  const rate = param.f32({ default: grain.rate, min: -2, max: 2, automationRate: 'a-rate' }).named('rate');
  const duration = param.f32({ default: grain.durationSeconds, min: .02, max: .15, automationRate: 'a-rate' }).named('durationSeconds');
  const density = param.f32({ default: grain.densityHz, min: 0, max: 20, automationRate: 'a-rate' }).named('densityHz');
  const gain = param.f32({ default: grain.gain, min: 0, max: .4, automationRate: 'a-rate' }).named('gain');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const out = audioOutput({ channels: 2, name: 'main' });
  return { process() { forSample(i => {
    const result = source.tick({ gate: gate.at(i).gte(.5), reset: reset.at(i).gte(.5),
      positionFrames: position.at(i), jitterFrames: jitter.at(i), rate: rate.at(i),
      durationSeconds: duration.at(i), densityHz: density.at(i) });
    const value = result.output.mul(gain.at(i));
    out.ch(0).at(i).write(value); out.ch(1).at(i).write(value);
  }); } };
});

/** CANDIDATE mono-in/stereo-out chain: soft first-order ADAA -> Q=.5 low-pass
 * -> asymmetric feed into stereo ping-pong. `main` input is finite mono <=1.
 * Dry/wet is intentional delay coloration; no external parallel-path alignment.
 */
export const shapedEcho = defineProcessor(({ sampleRate }) => {
  const input = audioInput({ channels: 1, name: 'main' });
  const out = audioOutput({ channels: 2, name: 'main' });
  const shaper = instantiate(drive, { sampleRate, curve: 'soft', quality: 'adaa' }, { name: 'drive' });
  const filter = instantiate(stateVariableFilter, { sampleRate }, { name: 'filter' });
  const delay = instantiate(pingPongDelay, { sampleRate, maxDelaySeconds: .25 }, { name: 'echo' });
  const driveGain = param.f32({ default: echo.drive, min: 0, max: 8, automationRate: 'a-rate' }).named('drive');
  const cutoff = param.f32({ default: echo.cutoffHz, min: 100, max: 4000, automationRate: 'a-rate' }).named('cutoffHz');
  const time = param.f32({ default: echo.delaySeconds, min: .04, max: .25, automationRate: 'a-rate' }).named('delaySeconds');
  const feedback = param.f32({ default: echo.feedback, min: 0, max: .4, automationRate: 'a-rate' }).named('feedback');
  const mix = param.f32({ default: echo.mix, min: 0, max: .6, automationRate: 'a-rate' }).named('mix');
  const gain = param.f32({ default: echo.gain, min: 0, max: .25, automationRate: 'a-rate' }).named('gain');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  return { process() { forSample(i => {
    const clear = reset.at(i).gte(.5);
    const x = shaper.tick(select(clear, f32(0), input.ch(0).at(i)), driveGain.at(i), f32(1), clear);
    const tone = filter.tick(x, cutoff.at(i), f32(.5), clear).lowpass;
    const wet = delay.tick(tone, tone.mul(.5), { timeSeconds: time.at(i), feedback: feedback.at(i),
      mix: mix.at(i), bypass: bool(false), reset: clear });
    out.ch(0).at(i).write(select(clear, f32(0), wet.left.mul(gain.at(i))));
    out.ch(1).at(i).write(select(clear, f32(0), wet.right.mul(gain.at(i))));
  }); } };
});
