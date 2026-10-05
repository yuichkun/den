import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate, select } from '@unworklet/core';
import { preparedConvolution, type PreparedConvolutionPacket } from '@denaudio/den/prepared-convolution';

export default defineProcessor(() => {
  const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 4, name: 'main' });
  const convolution = instantiate(preparedConvolution, { blockSize: 128, partitions: 64 }, { name: 'convolution' });
  const ir = event<PreparedConvolutionPacket>({ from: 'main', name: 'ir', capacity: CAPACITY_16, payloadCapacity: 131072 });
  ir.onReceive(packet => convolution.load(packet));
  return { process() { forSample((i, everyNSamples) => {
    const r = convolution.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples);
    output.ch(0).at(i).write(r.output); output.ch(1).at(i).write(select(r.loaded, f32(1), f32(0)));
    output.ch(2).at(i).write(select(r.rejected, f32(1), f32(0))); output.ch(3).at(i).write(f32(r.revision));
  }); } };
}, { id: 'den.prepared-convolution.consumer.v1' });
