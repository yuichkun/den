// Fixed, quantum-boundary MIDI input. These are listening/stress fixtures, not
// expected PCM; event order is intentionally retained for duplicate identities.
const midi = (q, type, note, velocity = 0) => ({ q, payload: { type, note, velocity, channel: 0 } });
const on = (q, note, velocity = 100) => midi(q, 'noteOn', note, velocity);
const off = (q, note) => midi(q, 'noteOff', note);
export const phrases = {
  bass: { quanta: 2048, events: [on(0,36),on(128,43),off(192,43),off(256,36),on(384,36,64),off(448,36),on(512,36,127),off(576,36),on(704,60),off(896,60),on(960,72),off(1152,72)], windows: { legato: [0,256], quiet: [384,448], loud: [512,576], upper: [960,1152] } },
  percussion: { quanta: 2048, events: [
    ...[[0,64],[192,100],[384,127]].flatMap(([q,v])=>[on(q,36,v),off(q+96,36)]),
    on(640,36),off(664,36),on(668,36),off(764,36),
    ...Array.from({length:8},(_,k)=>{const q=896+24*k;return [on(q,36),off(q+12,36)];}).flat(),
    on(1280,48),off(1376,48),
  ], windows: { quiet:[0,96], medium:[192,288], loud:[384,480], retrigger:[640,780], burst:[896,1100], upper:[1280,1376] } },
  pad: { quanta:6000, events:[...[48,55,60,64].map(n=>on(0,n,80)),off(3000,48),off(3375,55),off(3750,60),off(4125,64)], windows:{ attack:[0,300], motion:[1125,3000], release:[3000,5025] } },
};
export const stress = {
  bass: { quanta:2250, events:[on(0,36,127),on(128,43,127),off(192,43),off(750,36)], windows:{} },
  percussion: { quanta:2250, events:[on(0,36,127),off(24,36),on(28,36,127),off(124,36),on(300,48,127),off(396,48)], windows:{} },
  pad: { quanta:2250, events:[...Array.from({length:4},()=>on(0,69,127)),...Array.from({length:4},()=>off(750,69))], windows:{} },
};
export const steal = { quanta:3000, events:[...[60,64,67,71].map(n=>on(0,n,127)),off(375,60),on(375,72,127),on(750,74,127),off(1000,64),...[67,71,72,74].map(n=>off(1250,n))], windows:{} };
export function expand(fixture, sampleRate) {
  const frame = q => Math.round(q*sampleRate/48000)*128;
  return { frames:frame(fixture.quanta), midi:fixture.events.map(({q,payload})=>({name:'midi',atSample:frame(q),payload})), windows:Object.fromEntries(Object.entries(fixture.windows).map(([key,[a,b]])=>[key,[frame(a),frame(b)]])) };
}
