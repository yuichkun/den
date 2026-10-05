/** Fixed first prepared-convolution capacity. No sample-rate conversion here. */
export interface PreparedConvolutionConfig { blockSize: number; partitions: number }
export interface PreparedConvolutionPacket {
  formatVersion: number;
  blockSize: number;
  partitions: number;
  impulseFrames: number;
  declaredValues: number;
  spectrum: Float32Array;
}
export const PREPARED_BLOCK = 128;
export const PREPARED_FFT_SIZE = 256;
export const PREPARED_PARTITIONS = 64;
export const PREPARED_VALUES = 32768;
export const PREPARATION_ERROR_LIMIT = 4e-6;
const CERTIFICATE_GUARD = 1e-8;

export function validatePreparedConvolutionConfig(config: PreparedConvolutionConfig) {
  if (!config || config.blockSize !== PREPARED_BLOCK || config.partitions !== PREPARED_PARTITIONS) {
    throw new RangeError('preparedConvolution requires fixed blockSize 128 and partitions 64');
  }
}

/** Host-only preparation. Do not call from an audio callback.
 * Returns a complete native f32 packet; send it unchanged through the caller's
 * explicitly sized native event. The original IR is not normalized or clipped.
 * Quantization is approximate, with a guarded inverse-DFT error certificate.
 */
export function prepareConvolutionSpectrum(
  impulse: readonly number[] | Float32Array | Float64Array,
  config: PreparedConvolutionConfig,
): PreparedConvolutionPacket {
  validatePreparedConvolutionConfig(config);
  if (!(Array.isArray(impulse) || impulse instanceof Float32Array || impulse instanceof Float64Array) || impulse.length < 1 || impulse.length > 8192) {
    throw new RangeError('prepared convolution IR requires 1..8192 real taps');
  }
  const taps = Array.from(impulse);
  let absoluteSum = 0, compensation = 0;
  for (const tap of taps) {
    if (!Number.isFinite(tap) || Math.abs(tap) > 1) throw new RangeError('prepared convolution IR taps must be finite in [-1,1]');
    const increment = Math.abs(tap) - compensation, next = absoluteSum + increment;
    compensation = (next - absoluteSum) - increment; absoluteSum = next;
  }
  if (absoluteSum > 4) throw new RangeError('prepared convolution IR absolute sum must be <=4');

  const B = PREPARED_BLOCK, N = PREPARED_FFT_SIZE;
  const spectrum = new Float32Array(PREPARED_VALUES);
  const cosine = Float64Array.from({ length: N }, (_, n) => Math.cos(2 * Math.PI * n / N));
  const sine = Float64Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * n / N));
  // Independent inverse basis, with modulo-reduced arguments. It checks every
  // reconstructed tap, including the half that is ideally zero padding.
  const inverseCos = Float64Array.from({ length: N * N }, (_, index) => {
    const n = Math.floor(index / N), k = index % N;
    return Math.cos(2 * Math.PI * ((n * k) % N) / N);
  });
  const inverseSin = Float64Array.from({ length: N * N }, (_, index) => {
    const n = Math.floor(index / N), k = index % N;
    return Math.sin(2 * Math.PI * ((n * k) % N) / N);
  });
  let error = CERTIFICATE_GUARD;
  for (let p = 0; p < Math.ceil(taps.length / B); p++) {
    const values = Array.from({ length: B }, (_, n) => taps[p * B + n] ?? 0);
    if (values.every(value => value === 0)) continue;
    for (let k = 0; k <= N / 2; k++) {
      let real = 0, imag = 0;
      for (let n = 0; n < B; n++) { real += values[n] * cosine[(k * n) % N]; imag -= values[n] * sine[(k * n) % N]; }
      const re = Math.fround(real), im = k === 0 || k === N / 2 ? 0 : Math.fround(imag);
      if (!Number.isFinite(re) || !Number.isFinite(im) || Math.abs(re) > 4 || Math.abs(im) > 4) throw new RangeError('prepared convolution spectrum exceeds finite component bounds');
      spectrum[2 * (p * N + k)] = re; spectrum[2 * (p * N + k) + 1] = im;
      if (k > 0 && k < N / 2) { spectrum[2 * (p * N + N - k)] = re; spectrum[2 * (p * N + N - k) + 1] = -im; }
    }
    for (let n = 0; n < N; n++) {
      let real = 0, imag = 0;
      for (let k = 0; k < N; k++) {
        const re = spectrum[2 * (p * N + k)], im = spectrum[2 * (p * N + k) + 1];
        const c = inverseCos[n * N + k], s = inverseSin[n * N + k];
        real += re * c - im * s; imag += re * s + im * c;
      }
      error += Math.abs(real / N - (values[n] ?? 0)) + Math.abs(imag / N);
    }
  }
  if (!Number.isFinite(error) || error > PREPARATION_ERROR_LIMIT) throw new RangeError('prepared convolution IR exceeds the guarded 4e-6 quantization certificate');
  return { formatVersion: 1, blockSize: B, partitions: PREPARED_PARTITIONS, impulseFrames: taps.length, declaredValues: PREPARED_VALUES, spectrum };
}
