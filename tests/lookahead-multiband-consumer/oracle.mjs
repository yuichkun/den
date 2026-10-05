// Independent timeline and direct-form-I references; never import production DSP.
export const finite = (x, fallback = 0) => Number.isFinite(x) ? (x === 0 ? 0 : x) : fallback;
export const bounded = (x, lo, hi, fallback) => Math.max(lo, Math.min(hi, finite(x, fallback)));
export function limiterReference(inputs, rate, delay) {
  const [left, right, ceilings, releases, resets] = inputs;
  const result = Array.from({ length: 8 }, () => new Float64Array(left.length));
  let start = 0, envelope = 0;
  for (let n = 0; n < left.length; n++) {
    if (resets[n] > 0) { start = n; envelope = 0; }
    let peak = 0;
    // Deliberately linear history scan, unlike the production tree.
    for (let i = Math.max(start, n - delay); i <= n; i++) peak = Math.max(peak, Math.abs(finite(left[i])), Math.abs(finite(right[i])));
    const release = bounded(releases[n], 0, 30, 0);
    const coefficient = peak >= envelope || release === 0 ? 1 : -Math.expm1(-1 / Math.max(1, rate * release));
    envelope = (1 - coefficient) * envelope + coefficient * peak;
    const ceiling = 10 ** (bounded(ceilings[n], -120, 0, 0) / 20);
    const gain = envelope === 0 ? 1 : Math.min(1, ceiling / envelope);
    const dryLeft = n - delay < start ? 0 : finite(left[n - delay]);
    const dryRight = n - delay < start ? 0 : finite(right[n - delay]);
    [dryLeft * gain, dryRight * gain, dryLeft, dryRight, envelope, peak, gain, ceiling]
      .forEach((x, ch) => result[ch][n] = x);
  }
  return result;
}
export function coefficients(rate, frequency, kind) {
  const w = 2 * Math.PI * frequency / rate, c = Math.cos(w), a = Math.sin(w) / (2 * Math.fround(Math.SQRT1_2));
  const raw = kind === 'low' ? [(1-c)/2, 1-c, (1-c)/2] : [(1+c)/2, -1-c, (1+c)/2];
  return { b: raw.map(x => x/(1+a)), a: [1, -2*c/(1+a), (1-a)/(1+a)] };
}
export function direct(input, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return Float64Array.from(input, x => {
    const y = c.b[0]*x + c.b[1]*x1 + c.b[2]*x2 - c.a[1]*y1 - c.a[2]*y2;
    x2=x1; x1=x; y2=y1; y1=y; return y;
  });
}
export function lr4(input, rate, cutoff, kind) {
  const c = coefficients(rate, cutoff, kind);
  return Float32Array.from(direct(Float32Array.from(direct(input, c)), c));
}
export function splitReference(input, rate, lowHz, highHz) {
  const low = lr4(input, rate, lowHz, 'low'), upper = lr4(input, rate, lowHz, 'high');
  const lowLow = lr4(low, rate, highHz, 'low'), lowHigh = lr4(low, rate, highHz, 'high');
  return [Float32Array.from(low, (_, i) => lowLow[i]+lowHigh[i]), lr4(upper, rate, highHz, 'low'), lr4(upper, rate, highHz, 'high')];
}
export function response(signal, frequency, rate) {
  let re=0, im=0;
  for(let n=0;n<signal.length;n++){const phase=2*Math.PI*frequency*n/rate; re+=signal[n]*Math.cos(phase); im-=signal[n]*Math.sin(phase);}
  return {re,im,gain:Math.hypot(re,im)};
}
export function transfer(rate, cutoff, kind, frequency) {
  const {b,a}=coefficients(rate,cutoff,kind), w=-2*Math.PI*frequency/rate;
  const nr=b[0]+b[1]*Math.cos(w)+b[2]*Math.cos(2*w), ni=b[1]*Math.sin(w)+b[2]*Math.sin(2*w);
  const dr=1+a[1]*Math.cos(w)+a[2]*Math.cos(2*w), di=a[1]*Math.sin(w)+a[2]*Math.sin(2*w), d=dr*dr+di*di;
  const re=(nr*dr+ni*di)/d, im=(ni*dr-nr*di)/d;
  return {re:re*re-im*im,im:2*re*im};
}
export const add=(a,b)=>({re:a.re+b.re,im:a.im+b.im});
export const mul=(a,b)=>({re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re});
