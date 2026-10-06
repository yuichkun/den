import assert from 'node:assert/strict';

// Validate the scheduling arguments, not equality between asynchronous reads of
// AudioContext.currentTime. This is a test-only contract for the master's stop
// sequence; it does not claim that a device rendered the requested fade.
export function verifyMasterGainSchedules(calls, maximum) {
  assert(Array.isArray(calls)); assert(Number.isFinite(maximum) && maximum >= 0);
  const nodes = new Map(), schedules = [];
  const fail = (condition, message, evidence) => assert(condition, `${message}: ${JSON.stringify(evidence)}`);
  const finite = value => Number.isFinite(value);
  for (const call of calls) {
    fail(Number.isInteger(call.nodeId) && call.nodeId >= 0, 'missing GainNode identity', call);
    fail(Array.isArray(call.args) && call.args.every(finite) && finite(call.now) && call.now >= 0, 'nonfinite automation record', call);
    const node = nodes.get(call.nodeId) ?? { pending: null, ramps: 0 };
    nodes.set(call.nodeId, node);
    const context = { call, pending: node.pending };
    switch (call.name) {
      case 'setTargetAtTime':
        fail(call.args.length === 3 && call.args[0] >= 0 && call.args[0] <= maximum && call.args[1] >= 0 && call.args[2] === .015, 'master target/range/smoothing changed', call);
        fail(node.pending === null, 'target edit interrupted stop scheduling', context);
        break;
      case 'cancelScheduledValues':
        fail(call.args.length === 1 && call.args[0] >= 0, 'invalid cancellation anchor', call);
        fail(node.pending === null, 'incomplete previous stop schedule', context);
        // Production captures currentTime before entering the wrapper. That
        // captured start may be older than the observed clock, never future.
        fail(call.args[0] <= call.now, 'stop anchor is in the future', call);
        node.pending = { cancel: call, start: null };
        break;
      case 'setValueAtTime':
        fail(node.pending !== null && node.pending.start === null, 'missing or out-of-order cancellation', context);
        fail(call.args.length === 2 && call.args[0] >= 0 && call.args[0] <= maximum, 'master start value outside bounds', call);
        fail(call.args[1] === node.pending.cancel.args[0], 'cancel and set anchors differ', context);
        node.pending.start = call;
        break;
      case 'linearRampToValueAtTime': {
        fail(node.pending?.start != null, 'missing or mismatched-node stop anchor', context);
        const { cancel, start } = node.pending;
        const evidence = { nodeId: call.nodeId, cancel, start, ramp: call,
          scheduledDuration: call.args[1] - start.args[1], remainingAtInvocation: call.args[1] - call.now,
          clockAdvanceFromAnchor: call.now - start.args[1] };
        fail(call.args.length === 2 && call.args[0] === 0, 'stop ramp endpoint must be zero', evidence);
        fail(Math.abs(evidence.scheduledDuration - .02) < 1e-9, 'stop API interval must be 20 ms', evidence);
        // Keep actual late invocation separate: valid relative arguments do
        // not excuse an endpoint that is already due or in the past.
        fail(evidence.remainingAtInvocation > 0, 'stop endpoint is not future at invocation', evidence);
        schedules.push(evidence); node.ramps++; node.pending = null;
        break;
      }
      default: fail(false, 'unexpected master automation method', call);
    }
  }
  fail(schedules.length > 0, 'no stop ramp observed', { calls: calls.length });
  for (const [nodeId, node] of nodes) {
    fail(node.pending === null, 'unfinished stop schedule', { nodeId, pending: node.pending });
    fail(node.ramps > 0, 'master node has no completed stop ramp', { nodeId });
  }
  return { nodes: nodes.size, schedules, clockAdvancedSchedules: schedules.filter(s => s.clockAdvanceFromAnchor > 0).length,
    intervalTolerance: 1e-9, futureEndpointRequired: true, runtimeStatus: 'NOT_CLEARED' };
}
