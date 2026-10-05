import { defineSubgraph, f32, f64, i32, instantiate, select, state, type EveryNSamples, type MessageGraphPayload, type Node } from '@unworklet/core';
import { spectralFft, spectralForEach } from './spectral-fft.js';
import { PREPARED_BLOCK as B, PREPARED_FFT_SIZE as N, PREPARED_PARTITIONS as P, PREPARED_VALUES as VALUES,
  validatePreparedConvolutionConfig, type PreparedConvolutionConfig, type PreparedConvolutionPacket } from './convolution-spectrum.js';
export { prepareConvolutionSpectrum, type PreparedConvolutionConfig, type PreparedConvolutionPacket } from './convolution-spectrum.js';

/** Fixed B128/P64 prepared-spectrum mono convolution candidate.
 * Correctness/gain bounds require an unchanged packet from host preparation.
 * Caller owns native CAPACITY_16 ingress with payloadCapacity 131072 bytes.
 * Copy/scan runs in native dispatch, so preload with audible playback gated off.
 */
export const preparedConvolution = defineSubgraph((config: PreparedConvolutionConfig) => {
  validatePreparedConvolutionConfig(config);
  const coefficients = state.buffer.f32({ size: VALUES }).expose({ name: 'coefficients', snapshot: 'persistent' });
  const history = state.buffer.f64({ size: B }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const previous = state.buffer.f64({ size: VALUES }).expose({ name: 'previousSpectraScaled', snapshot: 'persistent' });
  const mixedReal = state.buffer.f64({ size: N }).expose({ name: 'mixedRealScaled', snapshot: 'transient' });
  const mixedImag = state.buffer.f64({ size: N }).expose({ name: 'mixedImagScaled', snapshot: 'transient' });
  const overlap = state.buffer.f64({ size: N }).expose({ name: 'overlapScaled', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor'), spectrumCursor = state.i32(0).named('spectrumCursor');
  const validSamples = state.i32(0).named('validSamples'), validBlocks = state.i32(0).named('validBlocks');
  const pendingReset = state.bool(true).named('pendingReset');
  const loaded = state.bool(false).named('loaded'), rejected = state.bool(false).named('rejected');
  const revision = state.i32(0).named('revision');
  const malformed = state.bool(false).expose({ name: 'malformed', snapshot: 'transient' });
  const sumReal = state.f64(0).expose({ name: 'sumRealScaled', snapshot: 'transient' });
  const sumImag = state.f64(0).expose({ name: 'sumImagScaled', snapshot: 'transient' });
  const fft = instantiate(spectralFft, { size: N }, { name: 'fft' });
  const scale = 2 ** 128;
  return {
    /** Module-specific native event payload; this is not a host loader/ack. */
    load(packet: MessageGraphPayload<PreparedConvolutionPacket>) {
      coefficients.copyFrom(packet.spectrum);
      const length = packet.spectrum.length;
      const header = packet.formatVersion.eq(1).and(packet.blockSize.eq(B)).and(packet.partitions.eq(P));
      const complete = header.and(packet.impulseFrames.gte(1)).and(packet.impulseFrames.lte(B * P)).and(packet.impulseFrames.floor().eq(packet.impulseFrames))
        .and(packet.declaredValues.eq(VALUES)).and(length.eq(VALUES));
      const unload = header.and(packet.impulseFrames.eq(0)).and(packet.declaredValues.eq(0)).and(length.eq(0));
      malformed.write(false);
      spectralForEach(P, p => spectralForEach(N, k => {
        const index = p.mul(N).add(k).mul(2), re = coefficients.read(index), im = coefficients.read(index.add(1));
        malformed.write(malformed.read().or(re.eq(re).not()).or(im.eq(im).not()).or(re.abs().gt(4)).or(im.abs().gt(4)));
      }));
      loaded.write(complete.and(malformed.read().not()));
      rejected.write(loaded.read().not().and(unload.not()));
      revision.write(revision.read().add(1));
      validSamples.write(0); validBlocks.write(0); pendingReset.write(true);
    },
    /** Once per sample, inside stride-1 forSample with its native scheduler.
     * Finite normalized input[-1,1]. Reset discards its sample and keeps the IR.
     * Reload clears prior tail but accepts the next sample after its handler.
     */
    tick(input: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples) {
      const invalidate = reset.or(loaded.read().not());
      validSamples.write(select(invalidate, i32(0), validSamples.read()));
      validBlocks.write(select(invalidate, i32(0), validBlocks.read()));
      pendingReset.write(pendingReset.read().or(invalidate));
      everyNSamples(B, () => {
        const frame = fft.transform(n => select(n.lt(B).and(validSamples.read().gte(i32(B).sub(n))),
          history.read(cursor.read().add(n).mod(B)), f64(0)), () => f64(0), false);
        spectralForEach(N, k => {
          const index = spectrumCursor.read().mul(N).add(k).mul(2);
          previous.write(index, frame.real(k)); previous.write(index.add(1), frame.imag(k));
        });
        spectralForEach(N, k => {
          sumReal.write(0); sumImag.write(0);
          spectralForEach(P, p => {
            const x = spectrumCursor.read().add(P).sub(p).mod(P).mul(N).add(k).mul(2);
            const h = p.mul(N).add(k).mul(2);
            const xr = select(validBlocks.read().gte(p), previous.read(x), f64(0));
            const xi = select(validBlocks.read().gte(p), previous.read(x.add(1)), f64(0));
            // Mask malformed/unloaded coefficient bytes before multiplication.
            const hr = f64(select(loaded.read(), coefficients.read(h), f32(0)));
            const hi = f64(select(loaded.read(), coefficients.read(h.add(1)), f32(0)));
            sumReal.write(sumReal.read().add(xr.mul(hr).sub(xi.mul(hi))));
            sumImag.write(sumImag.read().add(xr.mul(hi).add(xi.mul(hr))));
          });
          mixedReal.write(k, sumReal.read()); mixedImag.write(k, sumImag.read());
        });
        const result = fft.transform(n => mixedReal.read(n), n => mixedImag.read(n), true);
        spectralForEach(N, n => {
          const index = cursor.read().add(n).mod(N);
          overlap.write(index, select(pendingReset.read(), f64(0), overlap.read(index)).add(result.real(n)));
        });
        spectrumCursor.write(spectrumCursor.read().add(1).mod(P));
        validBlocks.write(validBlocks.read().add(1).min(P - 1));
        pendingReset.write(false);
      });
      const output = select(invalidate.or(pendingReset.read()), f32(0), f32(overlap.read(cursor.read()).div(scale)));
      overlap.write(cursor.read(), f64(0));
      history.write(cursor.read().mod(B), f64(select(invalidate, f32(0), input)).mul(scale));
      cursor.write(cursor.read().add(1).mod(N));
      validSamples.write(select(invalidate, i32(0), validSamples.read().add(1).min(B)));
      return { output, loaded: loaded.read(), rejected: rejected.read(), revision: revision.read() };
    },
  };
});
