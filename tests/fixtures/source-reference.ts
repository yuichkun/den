// Independent host-side mathematics. Never call or import the DSP under test.
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const f = Math.fround;
export function operatorReference(rate: number, controls: Float32Array[], fm: boolean) {
  let carrier = 0, modulator = 0, previous = 0;
  return Float32Array.from(controls[0], (_, n) => {
    if (controls[4][n]) carrier = modulator = previous = 0;
    const modulation = f(Math.sin(2 * Math.PI * modulator));
    const depth = clamp(controls[2][n], fm ? -0.45 * rate : -8 * Math.PI, fm ? 0.45 * rate : 8 * Math.PI);
    const feedback = clamp(controls[3][n], fm ? -0.45 * rate : -Math.PI, fm ? 0.45 * rate : Math.PI);
    const frequency = clamp(controls[0][n], 0, 0.45 * rate);
    const value = f(Math.sin(2 * Math.PI * carrier + (fm ? 0 : depth * modulation + feedback * previous)));
    carrier += (fm ? clamp(frequency + depth * modulation + feedback * previous, 0, 0.45 * rate) : frequency) / rate;
    modulator += clamp(controls[1][n], 0, 0.45 * rate) / rate;
    carrier -= Math.floor(carrier); modulator -= Math.floor(modulator);
    previous = value;
    return value;
  });
}

/** J_n(x) series with fixed small x, for analytical PM sidebands. */
export function bessel(order: number, x: number) {
  const n = Math.abs(order);
  let factorial = 1; for (let i = 2; i <= n; i++) factorial *= i;
  let term = (x / 2) ** n / factorial, sum = term;
  for (let k = 1; k < 32; k++) { term *= -(x * x / 4) / (k * (n + k)); sum += term; }
  return order < 0 && n % 2 ? -sum : sum;
}
export function sineBin(samples: Float32Array, bin: number) {
  let real = 0, imaginary = 0;
  samples.forEach((sample, n) => {
    real += sample * Math.cos(2 * Math.PI * bin * n / samples.length);
    imaginary += sample * Math.sin(2 * Math.PI * bin * n / samples.length);
  });
  return { magnitude: 2 * Math.hypot(real, imaginary) / samples.length, sine: 2 * imaginary / samples.length };
}
export function modalImpulse(rate: number, frames: number, modes: {frequencyHz:number;decaySeconds:number;gain:number}[]) {
  const total = modes.reduce((sum, m) => sum + Math.abs(m.gain), 0) || 1;
  return Float32Array.from({ length: frames }, (_, n) => modes.reduce((sum, m) => sum + m.gain / total *
    Math.exp(-Math.log(1000) * n / (m.decaySeconds * rate)) * Math.sin(2 * Math.PI * m.frequencyHz * (n + 1) / rate), 0));
}

/** Absolute-time delay history, independent of the DSP's circular-buffer layout. */
export function normalizedCombReference(rate: number, controls: Float32Array[], minimum = 20) {
  const history = new Float32Array(controls[0].length), output = new Float32Array(history.length);
  let resetFrame = 0, filtered = 0;
  for (let n = 0; n < history.length; n++) {
    if (controls[4][n]) { resetFrame = n; filtered = 0; }
    const requested = f(1 / clamp(controls[1][n], minimum, 0.45 * rate)) * rate;
    const delay = clamp(requested, 1, rate / minimum), whole = Math.floor(delay), fraction = f(delay - whole);
    const recent = n - whole >= resetFrame ? history[n - whole] : 0;
    const older = n - whole - 1 >= resetFrame ? history[n - whole - 1] : 0;
    const tap = f(f(recent * f(1 - fraction)) + f(older * fraction));
    const feedback = clamp(controls[2][n], -0.999, 0.999), damping = clamp(controls[3][n], 0, 1);
    filtered = tap * (1 - damping) + filtered * damping;
    history[n] = f(controls[0][n] * (1 - Math.abs(feedback)) + feedback * filtered);
    output[n] = tap;
  }
  return output;
}
