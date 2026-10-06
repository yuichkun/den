import { audioInput, audioOutput, defineProcessor, forSample, instantiate, select } from '@unworklet/core';
import { curvedAdsr, type CurvedAdsrConfig, type CurvedAdsrControls, type CurvedAdsrOutput } from '@denaudio/den/musical-controls';
export function makeEnvelopeProcessor() {
  return defineProcessor(ctx => {
    const config: CurvedAdsrConfig = { sampleRate: ctx.sampleRate };
    const input = audioInput({ channels: 10, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
    const unit = instantiate(curvedAdsr, config, { name: 'envelope' });
    return { process() { forSample(i => {
      const controls: CurvedAdsrControls = { gate: input.ch(0).at(i).gt(0), retrigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0),
        attack: input.ch(3).at(i), decay: input.ch(4).at(i), sustain: input.ch(5).at(i), release: input.ch(6).at(i),
        attackBend: input.ch(7).at(i), decayBend: input.ch(8).at(i), releaseBend: input.ch(9).at(i) };
      const result: CurvedAdsrOutput = unit.tick(controls);
      output.ch(0).at(i).write(result.level); output.ch(1).at(i).write(select(result.done, 1, 0));
    }); } };
  });
}
export default makeEnvelopeProcessor();
