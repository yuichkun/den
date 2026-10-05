// Host-only numerical feasibility proof, not a shipping preparer or DSP module.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const B = 128, N = 256, P = 64, maximum = B * P;
const cosine = Float64Array.from({ length: N }, (_, n) => Math.cos(2 * Math.PI * n / N));
const sine = Float64Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * n / N));
// Independent inverse-DFT matrix, generated separately from the forward roots.
const inverseCos = Array.from({ length: N }, (_, n) => Float64Array.from({ length: N }, (_, k) => Math.cos(2 * Math.PI * ((k * n) % N) / N)));
const inverseSin = Array.from({ length: N }, (_, n) => Float64Array.from({ length: N }, (_, k) => Math.sin(2 * Math.PI * ((k * n) % N) / N)));

function prepareForProof(impulse) {
  const packet = new Float32Array(2 * N * P), reconstructed = [], errors = [];
  let certificate = 0, maxComplexDeltaSum = 0, maxPaddedLeak = 0, maxImaginary = 0;
  const partitionCount = Math.ceil(impulse.length / B);
  for (let p = 0; p < partitionCount; p++) {
    const exact = [new Float64Array(N), new Float64Array(N)];
    const taps = Float64Array.from({ length: B }, (_, n) => impulse[p * B + n] ?? 0);
    for (let k = 0; k < N; k++) for (let n = 0; n < B; n++) {
      exact[0][k] += taps[n] * cosine[(k * n) % N];
      exact[1][k] -= taps[n] * sine[(k * n) % N];
    }
    for (let k = 0; k <= N / 2; k++) {
      const real = Math.fround(exact[0][k]), imag = k === 0 || k === N / 2 ? 0 : Math.fround(exact[1][k]);
      packet[2 * (p * N + k)] = real; packet[2 * (p * N + k) + 1] = imag;
      if (k > 0 && k < N / 2) { packet[2 * (p * N + N - k)] = real; packet[2 * (p * N + N - k) + 1] = -imag; }
    }
    let maxComplexDelta = 0;
    for (let k = 0; k < N; k++) {
      const deltaReal = packet[2 * (p * N + k)] - exact[0][k], deltaImag = packet[2 * (p * N + k) + 1] - exact[1][k];
      maxComplexDelta = Math.max(maxComplexDelta, Math.hypot(deltaReal, deltaImag));
      if (k > 0) { assert.equal(packet[2 * (p * N + k)], packet[2 * (p * N + N - k)]); assert.equal(packet[2 * (p * N + k) + 1] + packet[2 * (p * N + N - k) + 1], 0); }
    }
    maxComplexDeltaSum += maxComplexDelta;
    const q = new Float64Array(N), error = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      let real = 0, imag = 0;
      for (let k = 0; k < N; k++) {
        const re = packet[2 * (p * N + k)], im = packet[2 * (p * N + k) + 1];
        real += re * inverseCos[n][k] - im * inverseSin[n][k];
        imag += re * inverseSin[n][k] + im * inverseCos[n][k];
      }
      q[n] = real / N; error[n] = q[n] - (taps[n] ?? 0);
      certificate += Math.abs(error[n]) + Math.abs(imag / N);
      maxImaginary = Math.max(maxImaginary, Math.abs(imag / N));
      if (n >= B) maxPaddedLeak = Math.max(maxPaddedLeak, Math.abs(q[n]));
    }
    reconstructed.push(q); errors.push(error);
  }
  return { packet, reconstructed, errors, rawCertificate: certificate, guardedCertificate: certificate + 1e-8,
    frequencyBound: 2 * B * maxComplexDeltaSum, maxPaddedLeak, maxImaginary };
}
function directFir(input, impulse, sample) {
  let output = 0;
  for (let k = 0; k < impulse.length; k++) if (sample - B - k >= 0) output += input[sample - B - k] * impulse[k];
  return output;
}
function circularPartitionOutput(input, frames, sample) {
  const time = sample - B, block = Math.floor(time / B), phase = time % B;
  if (time < 0) return 0;
  let output = 0;
  for (let p = 0; p < frames.length; p++) for (let j = 0; j < B; j++) {
    const current = (block - p) * B + j, previous = (block - p - 1) * B + j;
    if (current >= 0 && current < input.length) output += input[current] * frames[p][(phase - j + N) % N];
    if (previous >= 0 && previous < input.length) output += input[previous] * frames[p][B + phase - j];
  }
  return output;
}
let seed = 1729;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 31 - 1; };
const randomIR = Array.from({ length: maximum }, random), norm = randomIR.reduce((s, x) => s + Math.abs(x), 0);
const cases = [
  ['identity', [1]],
  ['four_partition_edges', Array.from({ length: maximum }, (_, n) => [0, 127, 128, maximum - 1].includes(n) ? 1 : 0)],
  ['dense_dc', Array(maximum).fill(4 / maximum)],
  ['dense_nyquist', Array.from({ length: maximum }, (_, n) => (n % 2 ? -1 : 1) * 4 / maximum)],
  ['dense_seeded', randomIR.map(x => x * 3.999 / norm)],
  ['last_tap', Array.from({ length: maximum }, (_, n) => n === maximum - 1 ? 1 : 0)],
  ['tiny_ir', Array(maximum).fill(1e-46)],
  ['underflow_ir', Array(maximum).fill(1e-50)],
  ['zero_ir', Array(maximum).fill(0)],
];
const reports = [];
for (const [name, impulse] of cases) {
  const started = performance.now(), result = prepareForProof(impulse), preparationMs = performance.now() - started;
  const l1 = impulse.reduce((s, x) => s + Math.abs(x), 0), numericalGuard = l1 * 1e-11 + 1e-300;
  assert(l1 <= 4.000000000001); assert(result.guardedCertificate <= 4e-6, `${name}: preparation certificate`);
  let impulseError = 0;
  for (let phase = 0; phase < B; phase++) {
    const output = new Float64Array(B * (result.reconstructed.length + 2));
    result.reconstructed.forEach((q, p) => { for (let n = 0; n < N; n++) output[B + p * B + n] += q[(n - phase + N) % N]; });
    for (let n = 0; n < output.length; n++) impulseError = Math.max(impulseError, Math.abs(output[n] - (impulse[n - B - phase] ?? 0)));
  }
  let adversarialError = 0, seededError = 0;
  const frames = B * (P + 4), seededInput = Float32Array.from({ length: frames }, random);
  for (const phase of [0, 1, 63, 127]) {
    const outputBlock = P + 1, sample = B + outputBlock * B + phase;
    const weights = new Float64Array(frames);
    result.errors.forEach((error, p) => { for (let j = 0; j < B; j++) {
      weights[(outputBlock - p) * B + j] += error[(phase - j + N) % N];
      weights[(outputBlock - p - 1) * B + j] += error[B + phase - j];
    } });
    const worst = Float32Array.from(weights, x => Math.sign(x));
    adversarialError = Math.max(adversarialError, Math.abs(circularPartitionOutput(worst, result.reconstructed, sample) - directFir(worst, impulse, sample)));
    seededError = Math.max(seededError, Math.abs(circularPartitionOutput(seededInput, result.reconstructed, sample) - directFir(seededInput, impulse, sample)));
  }
  const maximumError = Math.max(impulseError, adversarialError, seededError);
  assert(maximumError <= result.rawCertificate + numericalGuard, `${name}: inverse-domain certificate violation`);
  assert(maximumError <= result.frequencyBound + numericalGuard, `${name}: complex frequency bound violation`);
  reports.push({ name, taps: impulse.length, originalL1: l1, preparationMs, rawCertificate: result.rawCertificate, guardedCertificate: result.guardedCertificate,
    frequencyBound: result.frequencyBound, maxPaddedLeak: result.maxPaddedLeak, maxImaginary: result.maxImaginary, impulsePhases: B, impulseError, adversarialError, seededError,
    coefficientTableAllZero: result.packet.every(x => x === 0) });
}
const output = { status: 'CANDIDATE host-only precision proof', blockSize: B, fftSize: N, partitions: P, coefficientType: 'f32', reports,
  limitations: ['No native convolution DSP tested here', 'Runtime rounding allowance is not established by this host proof', 'No relative accuracy guarantee for underflow-scale IRs'] };
writeFileSync('artifacts/convolution-spectrum-precision.json', JSON.stringify(output, null, 2)); console.log(JSON.stringify(output));
