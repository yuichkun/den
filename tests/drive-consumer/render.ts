import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { drive, reduction, type DriveCurve } from '@denaudio/den/drive';
import { driveReference } from './reference.ts';

const fill = (n: number, x = 0) => new Float32Array(n).fill(x);
const measurements: object[] = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const n = 8192;
  const x = Float32Array.from({ length: n }, (_, i) => 0.35 * (Math.sin(2 * Math.PI * 173 * i / sampleRate) + 0.3 * Math.sin(2 * Math.PI * 997 * i / sampleRate)));
  for (const curve of ['hard', 'soft', 'asymmetric', 'fold'] as DriveCurve[]) for (const quality of ['direct', 'adaa'] as const) {
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 1, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
      const unit = instantiate(drive, { sampleRate, curve, quality }, { name: 'drive' });
      const crusher = instantiate(reduction, { sampleRate }, { name: 'reduction' });
      return { process() { forSample(i => {
        output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), f32(6), f32(1), bool(false)));
        output.ch(1).at(i).write(crusher.tick(input.ch(0).at(i), f32(6), f32(5), f32(1), bool(false)));
      }); } };
    });
    const options = (signal: Float32Array, restore?: Uint8Array) => ({ sampleRate, duration: signal.length / sampleRate, inputs: { main: [signal] }, restore });
    const result = await renderOffline(processor, options(x));
    assert.equal(result.diagnostics.scrubbedSamples, 0);
    assert(result.outputs.main.every(ch => ch.length === n && ch.every(Number.isFinite)));
    const expected = driveReference(x, fill(n, 6), fill(n, 1), fill(n), curve, quality);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(result.outputs.main[0][i] - expected[i]));
      const held = Math.round(x[Math.floor(i / 5) * 5] * 32) / 32;
      // Math.round has a -0 convention; the specified lattice's zero is +0.
      assert.equal(result.outputs.main[1][i], held === 0 ? 0 : held);
    }
    assert(worst < 5e-6, 'independent quadrature/transfer mismatch: ' + worst);
    const first = await renderOffline(processor, options(x.slice(0, 4096)));
    const second = await renderOffline(processor, options(x.slice(4096), first.state));
    for (let ch = 0; ch < 2; ch++) assert.deepEqual(second.outputs.main[ch], result.outputs.main[ch].slice(4096));
    const name = `candidate-drive-${curve}-${quality}-${sampleRate}.f32`;
    writeFileSync(name, new Uint8Array(result.outputs.main[0].buffer));
    if (curve === 'hard' && quality === 'direct') writeFileSync(`candidate-reduction-${sampleRate}.f32`, new Uint8Array(result.outputs.main[1].buffer));
    measurements.push({ sampleRate, curve, quality, maximumOracleError: worst, peak: Math.max(...result.outputs.main[0].map(Math.abs)), frames: n });
  }
}
writeFileSync('drive-consumer-measurements.json', JSON.stringify(measurements, null, 2));
