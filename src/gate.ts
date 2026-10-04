import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { gateCell } from './index.js';

/** One-sample memory with gain: only an entry-path verification fixture. */
export const gate = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: 'main' });
  const output = audioOutput({ channels: 1, name: 'main' });
  const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: 'a-rate' }).named('gain');
  const cell = instantiate(gateCell, { scale: 1 }, { name: 'cell' });
  return { process() {
    forSample(i => output.ch(0).at(i).write(cell.tick(input.ch(0).at(i), gain.at(i))));
  } };
}, { id: 'den.entry.gate.v1' });
