import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeWav, decodeWav } from '@unworklet/offline';
import { chorusSettings, rhythmicDelaySettings } from '../dist/delay-settings.js';
import { inputs, render, reference, close } from '../tests/fixtures/delay-settings.mjs';

// Dedicated local listening packet, no upload or golden promotion.
const directory = 'artifacts/delay-settings';
mkdirSync(directory, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sampleRate = 48000, length = 262144;
const files = ['src/delay-settings.ts', 'src/delay-fx.ts', 'src/delay-readhead.ts', 'src/filter.ts', 'src/lfo.ts', 'tests/fixtures/delay-settings.mjs', 'scripts/render-delay-settings.mjs', 'scripts/plot-delay-settings.py', 'tests/delay-settings.spec.ts', 'tests/delay-settings-packed.test.mjs', 'package-lock.json'];
const manifest = {
  status: 'CANDIDATE', approval: null, previousApprovedAudio: null,
  description: 'Initial reference candidates, not approved golden. No normalization or limiter.',
  sourceCommit: git('rev-parse', 'HEAD'), sourceDirty: git('status', '--porcelain') !== '',
  sourceFiles: Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])),
  dependencies: { den: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, unworklet: '0.4.1', lockSHA256: hash(readFileSync('package-lock.json')) },
  sampleRate, channels: 2, frames: length, durationSeconds: length / sampleRate,
  initialState: 'Fresh engine: zero history/filter states and initial LFO phase; no restored snapshot',
  seed: null, midi: null, audioEncoding: 'IEEE float32 WAV',
  browserScope: '48kHz engine packed gate is separate; these candidate files are offline renders',
  cases: [],
};
for (const [name, setting] of [['chorus', chorusSettings], ['rhythmic-delay', rhythmicDelaySettings]]) {
  for (const edited of [false, true]) {
    const id = name + (edited ? '-edits' : '-base');
    const events = edited ? [
      { sample: 72000, values: name === 'chorus' ? { rateHz: 1.3, depthSeconds: 0.006 } : { bpm: 180, feedback: 0.65 } },
      { sample: 144000, values: { bypass: true } },
      { sample: 168000, values: { bypass: false } },
      { sample: 216000, values: { reset: true } },
      { sample: 216001, values: { reset: false } },
    ] : [];
    const controls = Object.fromEntries(Object.entries(setting.parameters).map(([key, initial]) => [key, n => {
      let value = initial;
      for (const event of events) if (event.sample <= n && key in event.values) value = event.values[key];
      return Number(value);
    }]));
    const source = n => {
      const t = n / sampleRate;
      if (t >= 2) return 0;
      if (name === 'chorus') {
        const envelope = Math.min(t / 0.02, 1, (2 - t) / 0.05);
        return envelope * (0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 330 * t) + 0.03 * Math.sin(2 * Math.PI * 440 * t));
      }
      const local = t % 0.5;
      return 0.3 * Math.exp(-local / 0.065) * (Math.sin(2 * Math.PI * 110 * local) + 0.25 * Math.sin(2 * Math.PI * 330 * local));
    };
    const data = inputs(sampleRate, controls, length, source, source);
    const result = await render(sampleRate, setting.config, data);
    const expected = reference(sampleRate, setting.config, data);
    result.outputs.main.forEach((a, ch) => close(a, expected[ch], ch < 2 ? 5e-6 : 0));
    const audio = result.outputs.main.slice(0, 2);
    const evidence = {};
    for (const [kind, channels] of [['input', data.audio], ['raw', audio]]) {
      const file = `${id}-${kind}.wav`, bytes = encodeWav(channels, sampleRate);
      writeFileSync(`${directory}/${file}`, bytes);
      const decoded = decodeWav(bytes);
      // Test the existing float encoder instead of assuming a lossless export.
      decoded.channels.forEach((channel, ch) => assert.deepEqual(channel, channels[ch]));
      evidence[kind] = { file, sha256: hash(bytes) };
    }
    const peaks = audio.map(a => a.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0));
    const errors = audio.map((a, ch) => a.reduce((worst, x, n) => Math.max(worst, Math.abs(x - expected[ch][n])), 0));
    manifest.cases.push({ id, setting, events, source: name === 'chorus'
      ? 'Identical mono L/R; 220/330/440Hz sine sum gains 0.12/0.06/0.03; 20ms linear attack, 50ms release; source stops at 2s.'
      : 'Identical mono L/R; four 0.5s plucks at t=0/0.5/1/1.5; 0.3*exp(-local/0.065)*(sin(2pi*110*local)+0.25*sin(2pi*330*local)); stops at 2s.',
      ...evidence, peaks, verification: { independentTimelineBiquadMaxError: errors, tolerance: 5e-6, scrubbedSamples: result.diagnostics.scrubbedSamples },
      listeningFocus: name === 'chorus' ? 'Slow widening and pitch motion; mono fold coloration; rate/depth edit can click.' : 'Dotted-eighth/quarter spacing and darkening repeats; abrupt tempo edit can jump/click; bypass hides but preserves tail.',
    });
  }
}
writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
execFileSync('python3', ['scripts/plot-delay-settings.py', directory], { stdio: 'inherit', env: { ...process.env, MPLCONFIGDIR: '/tmp/den-matplotlib', XDG_CACHE_HOME: '/tmp/den-font-cache' } });
console.log(`${directory}/manifest.json`);
