import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('packed delay settings render both candidates against independent reference at three rates', { timeout: 120000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-delay-settings-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  assert(pack.files.some(file => file.path === 'dist/delay-settings.d.ts'));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  // Exercise the package export boundary.
  writeFileSync(join(consumer, 'fixture.mjs'), readFileSync(join(root, 'tests/fixtures/delay-settings.mjs'), 'utf8').replace('../../dist/delay-fx.js', '@denaudio/den/delay-fx'));
  writeFileSync(join(consumer, 'settings-render.mjs'), `
import { writeFileSync } from 'node:fs';
import { chorusSettings, rhythmicDelaySettings } from '@denaudio/den/delay-settings';
import { inputs, render, reference, close } from './fixture.mjs';
const results=[];
for (const sampleRate of [44100,48000,96000]) {
  for (const [name, setting] of [['chorus',chorusSettings],['rhythmic-delay',rhythmicDelaySettings]]) {
    const source=n=>n<sampleRate/4 ? Math.sin(2*Math.PI*220*n/sampleRate)*0.1 : 0;
    const data=inputs(sampleRate,Object.fromEntries(Object.entries(setting.parameters).map(([k,v])=>[k,Number(v)])),131072,source,source);
    const result=await render(sampleRate,setting.config,data);
    const expected=reference(sampleRate,setting.config,data);
    result.outputs.main.forEach((a,ch)=>close(a,expected[ch],ch<2 ? 5e-6 : 0));
    results.push({name,sampleRate,frames:131072,status:'pass'});
  }
}
writeFileSync('settings-results.json',JSON.stringify(results,null,2));
`);
  run('node', ['settings-render.mjs'], consumer);
  const artifacts = join(root, 'artifacts/delay-settings'); mkdirSync(artifacts, { recursive: true });
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  copyFileSync(join(consumer, 'den.tgz'), join(artifacts, 'den.tgz'));
  copyFileSync(join(consumer, 'package-lock.json'), join(artifacts, 'consumer-package-lock.json'));
  writeFileSync(join(artifacts, 'packed-verification.json'), JSON.stringify({ status: 'pass', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), packageSHA256: hash(join(artifacts, 'den.tgz')), consumerLockSHA256: hash(join(artifacts, 'consumer-package-lock.json')), results: JSON.parse(readFileSync(join(consumer, 'settings-results.json'), 'utf8')), limitation: 'Public package imports; offline rendering only.' }, null, 2));
});
