import { createNode, inspect } from '@unworklet/core';
import {
  glassDyadParameters, glassDyadBrightParameters, makeGlassDyadTable,
  fmModalHitParameters, fmModalHitBellParameters,
  grainCloudParameters, grainCloudReverseParameters, makeGrainCloudSample,
  shapedEchoParameters, shapedEchoDarkParameters,
} from '@denaudio/den/musical-examples';
import glassProcessor from './glass-processor.ts?worklet';
import hitProcessor from './hit-processor.ts?worklet';
import grainProcessor from './grain-processor.ts?worklet';
import echoProcessor from './echo-processor.ts?worklet';
import provenance from './candidate-provenance.json';

const $ = id => document.getElementById(id);
const examples = {
  glass: { title: 'Glass dyad', description: 'Two independently held wavetable voices, with a shared original three-frame cycle bank.', variants: [glassDyadParameters, glassDyadBrightParameters], labels: ['A · Soft glass', 'B · Brighter harmonics'], processor: glassProcessor, asset: makeGlassDyadTable, length: 384, construction: 'Two voices · 3 × 128-sample original cycle frames · fixed pan weights · no MIDI allocator.', triggers: [['voice-a', 'Voice A', 'A', ['gateA']], ['voice-b', 'Voice B', 'S', ['gateB']], ['both', 'Hold dyad', 'Space', ['gateA', 'gateB']]] },
  hit: { title: 'FM / modal hit', description: 'A3 FM excitation and a three-mode impulse ring. Each new strike restarts the previous tail.', variants: [fmModalHitParameters, fmModalHitBellParameters], labels: ['A · Rounded hit', 'B · Bell-like ring'], processor: hitProcessor, construction: 'One fixed-pitch 220 Hz voice · 3 modal modes · gate rise strikes once; holding does not repeat.', triggers: [['strike', 'Strike', 'Space', ['gate']]] },
  grain: { title: 'Grain cloud', description: 'Two seeded grains over an original short tone cluster. Gate release lets active windows finish.', variants: [grainCloudParameters, grainCloudReverseParameters], labels: ['A · Forward cloud', 'B · Reverse cloud'], processor: grainProcessor, asset: makeGrainCloudSample, length: 4096, construction: 'Two-grain pool · original 4096-frame 48 kHz PCM · seed 1741 · no streaming or time stretching.', triggers: [['texture', 'Hold texture', 'Space', ['gate']]] },
  echo: { title: 'Shaped echo', description: 'Soft first-order ADAA, a Q0.5 low-pass, and asymmetric stereo repeats.', variants: [shapedEchoParameters, shapedEchoDarkParameters], labels: ['A · Open repeats', 'B · Darker repeats'], processor: echoProcessor, construction: 'Audition input: native 220 Hz sine with visible fixed 0.25 amplitude before processing. ADAA has a half-sample phase tradeoff; delay/filters add their documented phase and tails.', triggers: [['source', 'Hold source', 'Space', ['source']]] },
};
let selected = 'glass', variant = 'A', phase = 'idle', session = null, generation = 0;
let lastAsset = null, lastError = null, peakSeen = 0, animation = null;
const intents = new Map(), virtualTimers = new Set(), diagnostics = [], lifecycle = { started: 0, settled: 0, disposed: 0, closed: 0 };
let virtualSerial = 0;
const context = $('waveform').getContext('2d');
const current = () => examples[selected];
const live = s => session === s && !s.cancelled && s.generation === generation;
function status(text) { $('status').textContent = text; }
function controls() {
  const stopped = phase === 'idle';
  document.querySelectorAll('[data-example],[data-variant]').forEach(el => { el.disabled = !stopped; });
  $('start').disabled = !stopped; $('stop').disabled = stopped || phase === 'stopping';
  for (const name of ['release', 'clear']) $(name).disabled = phase !== 'ready';
  document.querySelectorAll('[data-trigger]').forEach(el => { el.disabled = phase !== 'ready'; });
}
function describe() {
  const e = current(), parameters = e.variants[variant === 'A' ? 0 : 1];
  $('material-title').textContent = e.title; $('material-description').textContent = e.description;
  $('variation-description').textContent = e.labels[variant === 'A' ? 0 : 1]; $('construction').textContent = e.construction;
  $('settings').textContent = JSON.stringify(parameters, null, 2);
  $('triggers').replaceChildren(...e.triggers.map(([id, label, key]) => {
    const button = document.createElement('button'); button.dataset.trigger = id; button.textContent = label;
    const small = document.createElement('small'); small.textContent = key; button.append(small);
    button.addEventListener('pointerdown', ev => {
      if (phase !== 'ready') return; ev.preventDefault(); try { button.setPointerCapture(ev.pointerId); } catch {} hold(`pointer:${ev.pointerId}`, id);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, ev => release(`pointer:${ev.pointerId}`));
    button.addEventListener('keydown', ev => {
      if (!['Enter', 'Space'].includes(ev.code) || phase !== 'ready') return;
      ev.preventDefault(); ev.stopPropagation(); if (!ev.repeat) hold(`key:${ev.code}`, id);
    });
    button.addEventListener('keyup', ev => {
      if (!['Enter', 'Space'].includes(ev.code)) return;
      ev.preventDefault(); ev.stopPropagation(); release(`key:${ev.code}`);
    });
    button.addEventListener('blur', () => { release('key:Enter'); release('key:Space'); });
    // Keyboard defaults are prevented above; detail=0 is virtual/assistive
    // activation. Pointer clicks already have a complete hold/release path.
    button.addEventListener('click', ev => {
      if (ev.detail !== 0 || phase !== 'ready') return;
      const token = `virtual:${++virtualSerial}`; hold(token, id);
      const timer = setTimeout(() => { virtualTimers.delete(timer); release(token); }, 180);
      virtualTimers.add(timer);
    });
    return button;
  }));
  $('play-hint').textContent = selected === 'glass' ? 'Hold A / S separately, or Space for both outside other controls. Focus a play button for Enter / Space holds; assistive clicks play 180 ms. Touch supports independent fingers.' : selected === 'hit' ? 'Press Space outside other controls, or hold Enter / Space on Strike. Assistive clicks play 180 ms. Release before the next hit.' : 'Hold Space outside other controls, or Enter / Space on the play button. Assistive clicks play 180 ms. Release to hear the remaining tail.';
  document.querySelectorAll('[data-example]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.example === selected)));
  document.querySelectorAll('[data-variant]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.variant === variant)));
  $('asset-state').textContent = e.asset ? 'Original asset is loaded only after Start; gates stay off until native state confirms receipt.' : 'No resident asset required.';
  controls();
}
function applyIntents() {
  const active = new Set([...intents.values()].flat());
  document.querySelectorAll('[data-trigger]').forEach(el => {
    const t = current().triggers.find(x => x[0] === el.dataset.trigger);
    const held = !!t && t[3].every(x => active.has(x));
    el.classList.toggle('held', held); el.setAttribute('aria-pressed', String(held));
  });
  const s = session; if (!s?.node || !live(s)) return;
  for (const name of ['gateA', 'gateB', 'gate']) if (s.node.params[name]) s.node.params[name].value = +(active.has(name) && phase === 'ready');
  if (s.sourceGain) {
    const target = active.has('source') && phase === 'ready' ? .25 : 0;
    if (target !== s.sourceTarget) {
      const now = s.ctx.currentTime, gain = s.sourceGain.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
      else { gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); }
      gain.setTargetAtTime(target, now, .01); s.sourceTarget = target;
    }
  }
}
function hold(token, id) { if (phase !== 'ready' || intents.has(token)) return; const trigger = current().triggers.find(x => x[0] === id); if (trigger) { intents.set(token, trigger[3]); applyIntents(); } }
function release(token) { if (intents.delete(token)) applyIntents(); }
function releaseAll() { for (const timer of virtualTimers) clearTimeout(timer); virtualTimers.clear(); intents.clear(); applyIntents(); }
async function waitAudio(s, seconds) {
  const target = s.ctx.currentTime + seconds, deadline = performance.now() + 10000;
  while (s.ctx.currentTime < target) {
    if (!live(s)) throw new Error('Audition cancelled');
    if (performance.now() > deadline) throw new Error('Audio context did not advance');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function snapshotBefore(s, deadline) {
  return new Promise((resolve, reject) => {
    const cancelled = () => finish(new Error('Audition cancelled'));
    const timer = setTimeout(() => finish(new Error('Native PCM preload acknowledgement timed out')), Math.max(0, deadline - performance.now()));
    const finish = (error, value) => { clearTimeout(timer); s.abort.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(value); };
    s.abort.signal.addEventListener('abort', cancelled, { once: true });
    if (!live(s)) { cancelled(); return; }
    // Attach both handlers even after cancellation so a late rejection cannot
    // become an unhandled promise or revive the old session.
    s.node.snapshot().then(value => finish(null, value), error => finish(error));
  });
}
async function preload(s, data) {
  s.node.events.load.emit({ data }); const deadline = performance.now() + 10000;
  while (live(s)) {
    const state = inspect(await snapshotBefore(s, deadline)); if (!live(s)) throw new Error('Audition cancelled');
    const slots = Object.entries(state.slots);
    const length = slots.find(([name, value]) => name.includes('asset') && name.endsWith('length') && value.kind === 'state');
    const pcm = slots.find(([name, value]) => name.includes('asset') && name.endsWith('pcm') && value.kind === 'buffer');
    if (length?.[1].value === data.length && pcm?.[1].length === data.length && pcm[1].head.every((value, n) => value === data[n])) {
      const digest = await crypto.subtle.digest('SHA-256', data); if (!live(s)) throw new Error('Audition cancelled');
      lastAsset = { length: data.length, sha256: [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join(''), nativeVerified: true };
      $('asset-state').textContent = `Native asset receipt verified: ${data.length} float32 frames. SHA256 ${lastAsset.sha256}`;
      return;
    }
    if (performance.now() > deadline) throw new Error('Native PCM preload could not be verified');
    await waitAudio(s, .01);
  }
  throw new Error('Audition cancelled');
}
function meters(s, output) {
  const split = new ChannelSplitterNode(s.ctx, { numberOfOutputs: 2 }); output.connect(split);
  return [0, 1].map(ch => { const a = new AnalyserNode(s.ctx, { fftSize: 4096 }); split.connect(a, ch); a.connect(s.mute); return a; });
}
async function dispose(s) {
  if (s.disposal) return s.disposal;
  s.disposal = (async () => {
    try { s.source?.stop(); } catch {}
    if (s.node && !s.nodeDisposed) { s.nodeDisposed = true; s.node.dispose(); lifecycle.disposed++; }
    if (s.ctx.state !== 'closed') { await s.ctx.close(); lifecycle.closed++; }
  })();
  return s.disposal;
}
async function start() {
  if (phase !== 'idle') return;
  const e = current(), parameters = { ...e.variants[variant === 'A' ? 0 : 1] };
  let ctx; try { ctx = new AudioContext({ sampleRate: 48000 }); } catch (error) { lastError = String(error.message || error); status(`Audio could not start: ${lastError}`); return; }
  const s = { generation: ++generation, abort: new AbortController(), cancelled: false, node: null, nodeDisposed: false, key: selected, variant, ctx };
  session = s; phase = 'loading'; lastError = null; lastAsset = null; peakSeen = 0; lifecycle.started++;
  controls(); status('Preparing a fresh 48 kHz candidate. Audio gates are off.');
  try {
    if (s.ctx.sampleRate !== 48000) throw new Error('This browser candidate requires 48 kHz');
    await s.ctx.resume(); if (!live(s)) return;
    const node = await createNode(s.ctx, e.processor, { initial: parameters });
    if (!live(s)) { node.dispose(); lifecycle.disposed++; return; }
    s.node = node;
    node.onError(error => {
      diagnostics.push({ code: error.code, message: String(error.message ?? '') });
      if (error.code !== 'sab-unavailable' && live(s)) { lastError = String(error.message || error.code || 'Audio error'); void stop(lastError); }
    });
    s.master = new GainNode(s.ctx, { gain: Number($('volume').value) }); s.mute = new GainNode(s.ctx, { gain: 0 }); s.mute.connect(s.ctx.destination);
    node.outputs.main.connect(s.master); s.master.connect(s.ctx.destination);
    s.raw = meters(s, node.outputs.main); s.output = meters(s, s.master);
    if (e.asset) await preload(s, e.asset());
    if (!live(s)) return;
    if (s.key === 'echo') {
      s.sourceTarget = 0; s.source = new OscillatorNode(s.ctx, { frequency: 220, type: 'sine' }); s.sourceGain = new GainNode(s.ctx, { gain: 0 });
      s.source.connect(s.sourceGain); s.sourceGain.connect(node.inputs.main); s.source.start();
    }
    phase = 'ready'; controls(); status('Ready. Press a control to play; Release leaves the tail, Stop fades and closes audio.'); applyIntents(); redraw();
  } catch (error) {
    if (live(s)) { lastError = String(error.message || error); await stop(lastError); }
  } finally { try { if (!live(s)) await dispose(s); } finally { lifecycle.settled++; } }
}
async function stop(message, immediate = false) {
  const s = session; if (!s) return;
  if (phase === 'stopping') { if (immediate) await dispose(s); return; }
  releaseAll(); s.cancelled = true; s.abort.abort(); generation++; phase = 'stopping'; controls(); status('Stopping and closing audio…');
  try {
    if (!immediate && s.master && s.ctx.state !== 'closed') { const now = s.ctx.currentTime; if (s.master.gain.cancelAndHoldAtTime) s.master.gain.cancelAndHoldAtTime(now); else { s.master.gain.cancelScheduledValues(now); s.master.gain.setValueAtTime(s.master.gain.value, now); } s.master.gain.linearRampToValueAtTime(0, now + .02); await new Promise(resolve => setTimeout(resolve, 35)); }
    await dispose(s);
  } finally {
    if (session === s) { session = null; phase = 'idle'; controls(); redraw(); status(message ? `Audio stopped: ${message}` : 'Audio is off. Choose a material and variation.'); }
  }
}
async function clear() {
  const s = session; if (phase !== 'ready' || !s?.node) return;
  releaseAll(); phase = 'clearing'; controls(); status('Clearing notes and tails…');
  try {
    if (s.sourceGain) { s.sourceGain.gain.cancelScheduledValues(s.ctx.currentTime); s.sourceGain.gain.setValueAtTime(0, s.ctx.currentTime); s.sourceTarget = 0; }
    s.node.params.reset.value = 1; await waitAudio(s, .04);
    if (!live(s)) return; s.node.params.reset.value = 0; phase = 'ready'; controls(); status('Cleared. Press a control to play.');
  } catch (error) { if (live(s)) { lastError = String(error); await stop(lastError); } }
}
function samples(analysers) { return analysers.map(a => { const x = new Float32Array(a.fftSize); a.getFloatTimeDomainData(x); return x; }); }
function stats(x) { return { peak: Math.max(...x.map(Math.abs)), rms: Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length), finite: x.every(Number.isFinite) }; }
function draw() {
  const s = session, channels = s?.output ? samples(s.output) : [new Float32Array(4096), new Float32Array(4096)];
  context.clearRect(0, 0, 960, 180); context.strokeStyle = '#294334';
  for (const y of [45, 135]) { context.beginPath(); context.moveTo(0, y); context.lineTo(960, y); context.stroke(); }
  for (let ch = 0; ch < 2; ch++) { context.strokeStyle = ch ? '#90b7ac' : '#d5e999'; context.beginPath(); for (let n = 0; n < 960; n++) { const value = channels[ch][Math.floor(n * channels[ch].length / 960)]; const y = 45 + ch * 90 - value * 39; if (n) context.lineTo(n, y); else context.moveTo(n, y); } context.stroke(); }
  const peaks = channels.map(x => stats(x).peak); peakSeen = Math.max(peakSeen, ...peaks);
  $('peak').textContent = s?.node ? `Observed L ${peaks[0].toFixed(4)} / R ${peaks[1].toFixed(4)} · session max ${peakSeen.toFixed(4)}` : 'L — / R —';
  animation = session?.output ? requestAnimationFrame(draw) : null;
}
function redraw() { if (animation === null) animation = requestAnimationFrame(draw); }
for (const el of document.querySelectorAll('[data-example]')) el.addEventListener('click', () => { if (phase !== 'idle') return; selected = el.dataset.example; variant = 'A'; releaseAll(); describe(); });
for (const el of document.querySelectorAll('[data-variant]')) el.addEventListener('click', () => { if (phase !== 'idle') return; variant = el.dataset.variant; describe(); });
$('start').addEventListener('click', () => void start()); $('stop').addEventListener('click', () => void stop()); $('release').addEventListener('click', releaseAll); $('clear').addEventListener('click', () => void clear());
$('volume').addEventListener('input', () => { const value = Math.min(1, Math.max(0, Number($('volume').value))); $('volume-value').textContent = `${value.toFixed(2)}×`; if (session?.master && live(session)) session.master.gain.setTargetAtTime(value, session.ctx.currentTime, .01); });
window.addEventListener('keydown', ev => { if (ev.repeat || phase !== 'ready' || ev.target.closest?.('input,select,textarea,button,a,summary,[contenteditable]')) return; const code = ev.code === 'Space' ? 'Space' : ev.code === 'KeyA' ? 'A' : ev.code === 'KeyS' ? 'S' : null; const t = current().triggers.find(x => x[2] === code); if (t) { ev.preventDefault(); hold(`key:${ev.code}`, t[0]); } });
window.addEventListener('keyup', ev => release(`key:${ev.code}`));
window.addEventListener('pointerup', ev => release(`pointer:${ev.pointerId}`)); window.addEventListener('pointercancel', ev => release(`pointer:${ev.pointerId}`));
window.addEventListener('blur', releaseAll); window.addEventListener('pagehide', () => void stop(undefined, true));
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop(undefined, true); });
$('provenance').textContent = `CANDIDATE · build source ${provenance.sourceCommit || 'unavailable'}${provenance.sourceDirty ? ' (local changes)' : ''} · package ${provenance.packageIntegrity} · Runtime NOT_CLEARED`;
// This diagnostic surface uses only the same UI actions, native analysers and
// native snapshot API. It does not supply a scheduler or alternate audio path.
window.denCatalog = {
  state: () => ({ selected, variant, phase, ready: phase === 'ready', started: lifecycle.started, settled: lifecycle.settled, disposed: lifecycle.disposed, closed: lifecycle.closed, lastAsset, lastError, errors: [...diagnostics], held: [...intents.values()].flat(), peakSeen, sourceCommit: provenance.sourceCommit, nativeParams: session?.node ? Object.fromEntries(Object.entries(session.node.params).map(([name, value]) => [name, value.value])) : null }),
  measure: async (seconds = .15) => {
    const s = session; if (!s?.node || phase !== 'ready') throw new Error('Audition is not ready');
    await waitAudio(s, seconds); await s.ctx.suspend();
    try { const raw = samples(s.raw), output = samples(s.output), volume = s.master.gain.value; return { sampleRate: s.ctx.sampleRate, volume, raw: raw.map(stats), output: output.map(stats), gainResidual: raw.map((x, ch) => Math.max(...x.map((v, n) => Math.abs(output[ch][n] - v * volume)))) }; }
    finally { if (live(s)) await s.ctx.resume(); }
  },
  clear, stop,
};
describe(); redraw();
