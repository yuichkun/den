import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { verifyMasterGainSchedules } from './gain-schedule-contract.mjs';

const production = readFileSync(new URL('./integration-consumer/main.js', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./integration.test.mjs', import.meta.url), 'utf8');
const stopCode = production.slice(production.indexOf('async function stop(){'), production.indexOf('\nfunction reset(){'));
const recordCode = fixture.slice(fixture.indexOf('const GN=GainNode;'), fixture.indexOf('\n   const AN=AnalyserNode;'));
assert(stopCode.startsWith('async function stop(){') && stopCode.includes('now+.02'));
assert(recordCode.includes('cancelScheduledValues') && recordCode.includes('nodeId'));
const quantum = 128 / 48000;

// Execute the actual production stop function and actual browser recorder with
// a controlled rendering clock. This proves their JS argument/order contract,
// not Web Audio rendering or the cause of the unclassified historical failure.
async function runStop(advance = 0, duration = '.02') {
  const reads = [12, 12, 12, 12 + advance]; let read = 0;
  class Clock {
    state = 'running';
    get currentTime() { return reads[Math.min(read++, reads.length - 1)]; }
    async close() { this.state = 'closed'; }
  }
  class NativeGain {
    constructor() {
      const parameter = { value: .75 };
      for (const name of ['setTargetAtTime', 'cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']) parameter[name] = () => parameter;
      this.gain = parameter;
    }
  }
  const context = vm.createContext({ GainNode: NativeGain, window: { AudioContext: Clock, __masters: [], __gainCalls: [] },
    stopping: false, closes: 0, releaseAll() {}, cancelAnimationFrame() {}, buttons() {}, status() {},
    $: () => ({ textContent: '' }), setTimeout: callback => { callback(); return 0; } });
  vm.runInContext(recordCode, context);
  const clock = new Clock(), master = new context.window.GainNode(clock);
  context.session = { ctx: clock, master, frame: 0, instrument: { dispose() {} }, delay: { dispose() {} } };
  vm.runInContext(`${stopCode.replace('now+.02', `now+(${duration})`)}\nthis.invokeStop=stop;`, context);
  await context.invokeStop();
  assert.equal(clock.state, 'closed'); assert.equal(context.session, null); assert.equal(context.stopping, false); assert.equal(context.closes, 1);
  return JSON.parse(JSON.stringify(context.window.__gainCalls));
}
const rejectedOldOracle = calls => {
  const ramp = calls.find(call => call.name === 'linearRampToValueAtTime');
  return Math.abs(ramp.args[1] - ramp.now - .02) < 1e-9;
};

test('actual stop arguments retain 20 ms intent across a rendering-clock advance; the old oracle can reject or mask it', async () => {
  const stable = await runStop(), advanced = await runStop(quantum);
  assert(rejectedOldOracle(stable)); assert(!rejectedOldOracle(advanced));
  assert.equal(verifyMasterGainSchedules(stable, 1).schedules.length, 1);
  const checked = verifyMasterGainSchedules(advanced, 1);
  assert.equal(checked.clockAdvancedSchedules, 1);
  assert(Math.abs(checked.schedules[0].remainingAtInvocation - (.02 - quantum)) < 1e-12);
  for (const quanta of [1, 8]) {
    const wrong = await runStop(quantum * quanta, `.02+${quanta}*128/48000`);
    assert(rejectedOldOracle(wrong), 'old clock comparison masks the wrong duration');
    assert.throws(() => verifyMasterGainSchedules(wrong, 1), /API interval must be 20 ms/);
  }
  const past = await runStop(8 * quantum);
  assert.throws(() => verifyMasterGainSchedules(past, 1), /not future at invocation/);
});

test('schedule recorder rejects missing, reordered, cross-node, wrong-duration/value/endpoint and late calls', async () => {
  const original = await runStop();
  const alter = update => { const calls = structuredClone(original); update(calls); return calls; };
  const negatives = [
    ['missing cancel', calls => calls.splice(0, 1)],
    ['missing set', calls => calls.splice(1, 1)],
    ['missing ramp', calls => calls.pop()],
    ['out of order', calls => { [calls[1], calls[2]] = [calls[2], calls[1]]; }],
    ['mismatched node', calls => { calls[2].nodeId = 9; }],
    ['different cancel/start', calls => { calls[1].args[1] += quantum; }],
    ['wrong duration', calls => { calls[2].args[1] += 1 / 48000; }],
    ['wrong endpoint', calls => { calls[2].args[0] = .01; }],
    ['start exceeds master bound', calls => { calls[1].args[0] = 1.01; }],
    ['negative start gain', calls => { calls[1].args[0] = -.01; }],
    ['due endpoint', calls => { calls[2].now = calls[2].args[1]; }],
    ['past endpoint', calls => { calls[2].now = calls[2].args[1] + quantum; }],
    ['future anchor', calls => { calls[0].args[0] += 1; calls[1].args[1] += 1; calls[2].args[1] += 1; }],
  ];
  for (const [name, mutation] of negatives) assert.throws(() => verifyMasterGainSchedules(alter(mutation), 1), undefined, name);
  const target = { nodeId: 0, name: 'setTargetAtTime', args: [.5, 12, .015], now: 12 };
  assert.equal(verifyMasterGainSchedules([target, ...original], 1).schedules.length, 1);
  for (const [name, index, value] of [['target bound', 0, 1.01], ['negative target', 0, -.01], ['smoothing', 2, .02], ['nonfinite time', 1, Infinity]]) {
    const bad = structuredClone(target); bad.args[index] = value;
    assert.throws(() => verifyMasterGainSchedules([bad, ...original], 1), undefined, name);
  }
  const second = original.map(call => ({ ...call, nodeId: 3 }));
  const interleaved = original.flatMap((call, index) => [call, second[index]]);
  assert.equal(verifyMasterGainSchedules(interleaved, 1).schedules.length, 2, 'independent GainNodes keep separate anchors');
  assert.throws(() => verifyMasterGainSchedules([target], 1), /no stop ramp/);
});
