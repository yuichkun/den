import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRealtimeProbe } from '../scripts/probe-realtime.mjs';
import { buildConsumer, buildStandaloneConsumer } from '../scripts/build-consumer.mjs';
import { buildIntegrationFixture } from '../scripts/build-integration.mjs';
import { buildCatalogFixture } from '../scripts/build-catalog.mjs';

test('manual realtime probe routes its original capture to an isolated fixture without touching public output', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'den-probe-routing-'));
  const isolated = join(temp, 'consumer', 'dist'), publicOutput = join(temp, 'site-dist');
  mkdirSync(isolated, { recursive: true }); mkdirSync(publicOutput);
  writeFileSync(join(publicOutput, 'index.html'), 'Rebuilding the playground.');
  writeFileSync(join(isolated, 'audition.html'), 'isolated audio fixture');
  const calls = [], expected = [{ mode: 'routing-probe-only' }];
  const result = await runRealtimeProbe({
    build(options) { calls.push(['build', options]); return { output: isolated }; },
    async capture(output, artifacts) {
      calls.push(['capture', output, artifacts]);
      assert.equal(readFileSync(join(output, 'audition.html'), 'utf8'), 'isolated audio fixture');
      assert.notEqual(output, publicOutput);
      return expected;
    },
  });
  assert.deepEqual(calls, [['build', { stageSite: false }], ['capture', isolated, 'artifacts/realtime/manual']]);
  assert.equal(result, expected);
  assert.equal(readFileSync(join(publicOutput, 'index.html'), 'utf8'), 'Rebuilding the playground.');
});
test('manual probe propagates fixture-build failure and does not start capture', async () => {
  let captures = 0;
  await assert.rejects(runRealtimeProbe({ build() { throw new Error('fixture build failed'); }, capture() { captures++; } }), /fixture build failed/);
  assert.equal(captures, 0);
});
test('development fixture builder rejects public staging before any package build', () => {
  assert.throws(() => buildConsumer({ stageSite: true }), /cannot write public site-dist/);
});

test('every standalone build command requests its isolated fixture and preserves public output', () => {
  const root = mkdtempSync(join(tmpdir(), 'den-command-routing-'));
  const publicOutput = join(root, 'site-dist'); mkdirSync(publicOutput);
  writeFileSync(join(publicOutput, 'index.html'), 'Rebuilding the playground.');
  for (const [command, expected] of [
    [buildStandaloneConsumer, { stageSite: false }],
    [buildIntegrationFixture, { fixture: 'tests/integration-consumer', stageSite: false }],
    [buildCatalogFixture, { fixture: 'tests/catalog-audition-consumer', stageSite: false }],
  ]) {
    let calls = 0;
    const result = command(options => {
      calls++;
      assert.deepEqual(options, expected);
      const output = join(mkdtempSync(join(root, 'consumer-')), 'dist');
      mkdirSync(output); writeFileSync(join(output, 'index.html'), 'development fixture');
      return { output };
    });
    assert.equal(calls, 1);
    assert.notEqual(result.output, publicOutput);
    assert.equal(readFileSync(join(publicOutput, 'index.html'), 'utf8'), 'Rebuilding the playground.');
  }
});
