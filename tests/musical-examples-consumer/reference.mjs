// Independent scalar/analytic references. No den DSP, controls or asset builders.
const f = Math.fround;
const frames = (seconds, rate) => Math.round(f(seconds) * rate);
const at = (p, key, n) => f(p[key][Math.min(n, p[key].length - 1)]);
export function expectedTable() {
  const out = new Float32Array(384);
  const weights = [[.8, 0, 0], [.6, .2, 0], [.4, .25, .15]];
  weights.forEach((row, frame) => { for (let n = 0; n < 128; n++) out[frame * 128 + n] = row.reduce((s, w, h) => s + w * Math.sin(2 * Math.PI * (h + 1) * n / 128), 0); });
  return out;
}
export function expectedGrainAsset() {
  return Float32Array.from({ length: 4096 }, (_, n) => {
    const harmonics = [19, 31, 47], levels = [.32, .17, .08];
    return harmonics.reduce((s, k, i) => s + levels[i] * Math.sin(2 * Math.PI * k * n / 4096), 0)
      * (.55 - .45 * Math.cos(2 * Math.PI * n / 4096));
  });
}
function read(data, position, start = 0, length = data.length) {
  const wrapped = ((position % length) + length) % length, base = Math.floor(wrapped), t = wrapped - base;
  return f(data[start + base] * (1 - t) + data[start + ((base + 1) % length)] * t);
}
// Piecewise closed-form line segments from gate transition timestamps. Not the
// production remaining-frames/state-machine recurrence.
function ampCurve(gates, resets, rate, attack, decay, sustain, release) {
  const a = frames(attack, rate), d = frames(decay, rate), r = frames(release, rate);
  let origin = 0, begin = -Infinity, releaseAt = -Infinity, releaseLevel = 0, previous = false, silent = true;
  const held = age => age < a ? origin + (1 - origin) * (age + 1) / a
    : age - a < d ? 1 + (f(sustain) - 1) * (age - a + 1) / d : f(sustain);
  let last = 0;
  return Float32Array.from(gates, (value, n) => {
    const gate = value >= .5;
    if (gate && !previous) { origin = last; begin = n; silent = false; releaseAt = Infinity; }
    if (!gate && previous) { releaseAt = n; releaseLevel = last; }
    if (resets[n] >= .5) { silent = true; last = 0; }
    else last = silent ? 0 : n >= releaseAt ? releaseLevel * Math.max(0, 1 - (n - releaseAt + 1) / r) : held(n - begin);
    previous = gate;
    return last;
  });
}
export function glassReference(p, rate, length) {
  const data = expectedTable(), outputs = [new Float32Array(length), new Float32Array(length)];
  const envelope = ['A', 'B'].map(s => ampCurve(p[`gate${s}`], p.reset, rate, .012, .2, .65, .28));
  const phase = [0, 0], wasGate = [false, false];
  for (let n = 0; n < length; n++) {
    const values = ['A', 'B'].map((suffix, voice) => {
      const gate = at(p, `gate${suffix}`, n) >= .5;
      if (gate && !wasGate[voice] || at(p, 'reset', n) >= .5) phase[voice] = 0;
      const frame = at(p, 'frame', n), lower = Math.floor(frame), fraction = frame - lower;
      const low = read(data, phase[voice] * 128, lower * 128, 128), high = read(data, phase[voice] * 128, Math.min(2, lower + 1) * 128, 128);
      const value = f(f(low * (1 - fraction) + high * fraction) * envelope[voice][n]);
      phase[voice] = (phase[voice] + at(p, `frequency${suffix}`, n) / rate) % 1;
      wasGate[voice] = gate;
      return at(p, 'reset', n) >= .5 ? 0 : value;
    });
    outputs[0][n] = f(f(f(values[0] * .75) + f(values[1] * .25)) * at(p, 'gain', n));
    outputs[1][n] = f(f(f(values[0] * .25) + f(values[1] * .75)) * at(p, 'gain', n));
  }
  return outputs;
}
export function hitReference(p, rate, length) {
  const env = ampCurve(p.gate, p.reset, rate, .001, .18, 0, .04), result = new Float32Array(length);
  const modes = [[220, .42, 1], [351, .24, .6], [563, .15, .35]];
  let phase = 0, modPhase = 0, wasGate = false, lastStrike = -Infinity, velocity = 0;
  for (let n = 0; n < length; n++) {
    const gate = at(p, 'gate', n) >= .5, clear = at(p, 'reset', n) >= .5, strike = gate && !wasGate && !clear;
    if (strike || clear) { phase = 0; modPhase = 0; lastStrike = clear ? -Infinity : n; velocity = clear ? 0 : at(p, 'strength', n); }
    const tone = f(Math.sin(2 * Math.PI * phase)), mod = f(Math.sin(2 * Math.PI * modPhase));
    const deviation = f(at(p, 'deviationHz', n) * env[n]);
    phase = (phase + (220 + deviation * mod) / rate) % 1;
    modPhase = (modPhase + f(220 * at(p, 'ratio', n)) / rate) % 1;
    const age = n - lastStrike;
    const ring = Number.isFinite(age) ? f(velocity * modes.reduce((sum, [hz, t60, weight]) => sum + weight / 1.95 * Math.exp(-Math.log(1000) * age / (t60 * rate)) * Math.sin(2 * Math.PI * hz * (age + 1) / rate), 0)) : 0;
    const mix = at(p, 'modalMix', n), body = f(f(f(tone * env[n]) * velocity) * f(1 - mix));
    result[n] = clear ? 0 : f(f(body + f(ring * mix)) * at(p, 'gain', n));
    wasGate = gate;
  }
  return [result, result.slice()];
}
export function grainReference(p, hostRate, length) {
  const data = expectedGrainAsset(), result = new Float32Array(length), pool = [];
  let random = 1741n, clock = 0, wasGate = false;
  for (let n = 0; n < length; n++) {
    const gate = at(p, 'gate', n) >= .5, clear = at(p, 'reset', n) >= .5, rising = gate && !wasGate;
    if (clear || rising) clock = 0;
    if (clear) { random = 1741n; pool.length = 0; }
    const onset = gate && !clear && (rising || clock >= 1);
    for (let j = pool.length - 1; j >= 0; j--) if (n - pool[j].start >= pool[j].duration) pool.splice(j, 1);
    if (onset) {
      random = random * 48271n % 2147483647n;
      if (pool.length < 2) pool.push({ start: n, duration: frames(at(p, 'durationSeconds', n), hostRate),
        position: Math.max(0, Math.min(4095, at(p, 'positionFrames', n) + (Number(random) / 2147483647 * 2 - 1) * at(p, 'jitterFrames', n))),
        speed: at(p, 'rate', n) * 48000 / hostRate });
    }
    let sum = 0;
    for (const grain of pool) {
      const age = n - grain.start, window = Math.max(0, 1 - Math.abs(2 * age / (grain.duration - 1) - 1));
      sum += read(data, grain.position) * window;
      // Sequential position accumulation is part of the documented reader.
      grain.position = ((grain.position + grain.speed) % data.length + data.length) % data.length;
    }
    result[n] = f(f(sum / 2) * at(p, 'gain', n));
    clock = gate && !clear ? clock - Math.floor(clock) + at(p, 'densityHz', n) / hostRate : 0;
    wasGate = gate && !clear;
  }
  return [result, result.slice()];
}
function soft(x) { return Math.abs(x) >= 1 ? Math.sign(x) : (3 * x - x ** 3) / 2; }
function quadrature(a, b) {
  if (a === b) return soft(a);
  const lo = Math.min(a, b), hi = Math.max(a, b), knots = [lo, ...[-1, 1].filter(x => x > lo && x < hi), hi];
  let total = 0;
  for (let n = 1; n < knots.length; n++) {
    const x = knots[n - 1], y = knots[n];
    total += (y - x) / 6 * (soft(x) + 4 * soft((x + y) / 2) + soft(y));
  }
  return total / (hi - lo);
}
export function echoReference(p, rate, input) {
  // Static-cutoff reference: bilinear direct-form transfer equation, distinct
  // from production TPT state integrators. It is NOT a moving-coefficient oracle.
  if (p.cutoffHz.some(x => x !== p.cutoffHz[0])) throw new Error('echo oracle requires a fixed cutoff');
  const g = Math.tan(Math.PI * f(p.cutoffHz[0]) / rate), denominator = 1 + 2 * g + g * g;
  const b0 = g * g / denominator, b1 = 2 * b0, b2 = b0;
  const a1 = 2 * (g * g - 1) / denominator, a2 = (1 - 2 * g + g * g) / denominator;
  let previous = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0, epoch = 0;
  const lines = [new Float32Array(input.length), new Float32Array(input.length)], out = lines.map(x => x.slice());
  const lookup = (line, t) => {
    const base = Math.floor(t), fraction = t - base;
    const a = base < epoch ? 0 : line[base], b = base + 1 < epoch ? 0 : line[base + 1];
    return f(a * (1 - fraction) + b * fraction);
  };
  for (let n = 0; n < input.length; n++) {
    const clear = at(p, 'reset', n) >= .5;
    if (clear) { previous = x1 = x2 = y1 = y2 = 0; epoch = n; }
    const driven = (clear ? 0 : input[n]) * at(p, 'drive', n), shaped = f(quadrature(previous, driven));
    previous = driven;
    const filtered = b0 * shaped + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = shaped; y2 = y1; y1 = filtered;
    const tone = f(filtered), time = at(p, 'delaySeconds', n) * rate, wet = lines.map(line => lookup(line, n - time));
    const feedback = at(p, 'feedback', n), mix = at(p, 'mix', n), dry = [tone, f(tone * .5)];
    for (let ch = 0; ch < 2; ch++) {
      lines[ch][n] = f(dry[ch] + f(wet[1 - ch] * feedback));
      out[ch][n] = clear ? 0 : f(f(f(dry[ch] * f(1 - mix)) + f(wet[ch] * mix)) * at(p, 'gain', n));
    }
  }
  return out;
}
