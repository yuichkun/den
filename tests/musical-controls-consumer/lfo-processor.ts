import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { musicalLfo, type MusicalLfoConfig, type MusicalLfoControls, type MusicalLfoOutput, type MusicalLfoWaveform } from '@denaudio/den/musical-controls';
export const waveforms: MusicalLfoWaveform[] = ['sine', 'triangle', 'saw', 'square'];
export function makeLfoProcessor(mode: MusicalLfoConfig['mode'] = 'tempo', beatsPerCycle = 1 / 4) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 6, name: 'controls' }), output = audioOutput({ channels: 8, name: 'main' });
    const units = waveforms.map((waveform, n) => {
      const config: MusicalLfoConfig = { sampleRate: ctx.sampleRate, mode, waveform, beatsPerCycle };
      return instantiate(musicalLfo, config, { name: `lfo${n}` });
    });
    return { process() { forSample(i => {
      const controls: MusicalLfoControls = { rate: input.ch(0).at(i), reset: input.ch(1).at(i).gt(0), seek: input.ch(2).at(i).gt(0),
        position: input.ch(3).at(i), phaseOffset: input.ch(4).at(i), hold: input.ch(5).at(i).gt(0) };
      units.forEach((unit, n) => {
        const result: MusicalLfoOutput = unit.tick(controls);
        output.ch(n * 2).at(i).write(result.value); output.ch(n * 2 + 1).at(i).write(result.phase);
      });
    }); } };
  });
}
export default makeLfoProcessor();
