import assert from 'node:assert/strict';
// Independent frequency-domain resolvent, originally verified by the separate
// component reviewer. No shipping module or time-domain fixture is imported.
const complex = (re = 0, im = 0) => [re, im];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const div = (a, b) => scale(mul(a, [b[0], -b[1]]), 1 / (b[0] ** 2 + b[1] ** 2));
const abs = a => Math.hypot(...a);
const z = (omega, delay) => [Math.cos(omega * delay), -Math.sin(omega * delay)];
function solve(matrix, vector) {
  const a = matrix.map((row, i) => [...row.map(x => [...x]), [...vector[i]]]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (abs(a[r][col]) > abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col]; assert(abs(d) > 1e-12);
    for (let k = col; k < 5; k++) a[col][k] = div(a[col][k], d);
    for (let r = 0; r < 4; r++) if (r !== col) { const f = a[r][col]; for (let k = col; k < 5; k++) a[r][k] = sub(a[r][k], mul(f, a[col][k])); }
  }
  return a.map(row => row[4]);
}
function delayTransfer(omega, sampleRate, seconds, maximum) {
  const age = Math.max(1, Math.min(maximum, sampleRate * Math.fround(seconds)));
  const m = Math.floor(age), fraction = Math.fround(age - m);
  return add(scale(z(omega, m), Math.fround(1 - fraction)), scale(z(omega, m + 1), fraction));
}
export function componentTransfer(sampleRate, omega) {
  // Frequency-domain derivation: y = D (b x + H/2 G L y), so y/x = (I-D H/2 G L)^-1 D b.
  const h = [[1,1,1,1],[1,-1,1,-1],[1,1,-1,-1],[1,-1,-1,1]];
  const lengths = [.0297,.0371,.0411,.0437].map(t => Math.round(t * sampleRate));
  const delays = lengths.map(d => delayTransfer(omega, sampleRate, d / sampleRate, Math.max(1, sampleRate * (d / sampleRate))));
  const pole = Math.exp(-2 * Math.PI * Math.min(3500, .4 * sampleRate) / sampleRate);
  const lowpass = div(complex(1 - pole), sub(complex(1), scale(z(omega, 1), pole)));
  const loop = lengths.map(d => scale(lowpass, 10 ** (-3 * d / (sampleRate * .6))));
  const matrix = h.map((row, i) => row.map((sign, j) => sub(complex(Number(i === j)), scale(mul(delays[i], loop[j]), sign / 2))));
  const y = solve(matrix, delays.map(d => scale(d, .5)));
  const late = [h[2],h[3]].map(row => row.reduce((sum, sign, i) => add(sum, scale(y[i], sign / 2)), complex()));
  const color = mul(z(omega,8), add(add(complex(.625),scale(z(omega,3),.25)),scale(z(omega,7),-.125)));
  const taps = [[.007,.5,.25],[.013,.25,-.25],[.023,-.125,.375]];
  const early = [1,2].map(ch => mul(color,taps.reduce((sum,t) => add(sum,scale(delayTransfer(omega,sampleRate,t[0],.023*sampleRate),t[ch])),complex())));
  return { early, late };
}
export function predictedTransfer(sampleRate, omega, mix, pitchMix, width, pitched) {
  const { early, late } = componentTransfer(sampleRate, omega);
  const pitch = pitched ? add(complex(1-pitchMix),scale(z(omega,1+width/2),pitchMix)) : complex(1);
  return early.map((e,ch) => add(complex(1-mix),scale(add(e,mul(late[ch],pitch)),mix/2)));
}
export function observedBin(samples, phase, multiplier = 1) {
  let real = 0, imag = 0;
  for (let n = 0; n < samples.length; n++) {
    const angle = 2 * Math.PI * phase[n] * multiplier / 128;
    real += samples[n] * Math.cos(angle); imag -= samples[n] * Math.sin(angle);
  }
  return scale([real, imag], 2 / samples.length);
}
export { add, sub, mul, scale, abs };
