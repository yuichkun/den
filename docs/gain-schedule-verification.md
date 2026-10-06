# Master stop scheduling: argument and clock observations

The instrument's existing stop path captures `AudioContext.currentTime` once,
cancels scheduled values at that time, sets the current master level at the same
time, and requests a zero endpoint 20 ms later. This change leaves that runtime
code and every audio/gain threshold unchanged.

The previous browser assertion compared the endpoint with a second clock read
inside its recorder. [The Web Audio clock definition](https://www.w3.org/TR/webaudio-1.0/#dom-baseaudiocontext-currenttime)
allows the rendering clock to advance between those reads. A correct 20 ms
schedule can therefore fail the old assertion. Conversely, an incorrect duration
can appear correct when a clock advance masks its error.

## Retained observation

Post-main run [37399904290](https://github.com/yuichkun/den/actions/runs/37399904290)
on `6e947866f2be5fcf2f74dfc75ea8ebafc90b0258` failed the inherited assertion
`abs(rampEnd - sampledCurrentTime - .02) < 1e-9`. Full artifact `11385641596`
has SHA256 `669a4720f7852e9b48dd52add8623cc0f84428528bf817f5e851352624f286f4`.
The exact recorded argument/clock tuple was not available for comparison, so
that specific run remains unclassified. The source-based counterexamples below
do not prove whether its endpoint was still future or had actually become late.

## Corrected invariant

The test records `cancelScheduledValues`, `setValueAtTime`,
`linearRampToValueAtTime` and `setTargetAtTime` for each individual GainNode.
Each completed stop must have, in order:

1. A nonfuture cancellation anchor.
2. A set-value call at exactly the same anchor, within the master gain range.
3. A zero ramp endpoint exactly 20 ms after that anchor, retaining the existing
   1e-9-second interval tolerance.
4. An endpoint that is still strictly future at the independently sampled ramp
   invocation clock. Correct relative arguments do not excuse a due/past target.

Every recorded master must finish its sequence. Calls from different nodes cannot
supply each other's anchors. Target smoothing remains exactly 15 ms and its gain
range is unchanged. Raw calls, scheduled duration, clock advance and remaining
time are retained; failures print the complete offending sequence.

The small source-extracted Node tests execute the actual stop function and its
actual recorder with controlled clock reads. One 128/48000-second advance makes
the old oracle reject a correct schedule even though 17.333 ms remains. Incorrect
22.6667 ms and 41.3333 ms intervals can pass that old oracle when matching clock
advances mask them. The corrected invariant rejects those, missing/reordered or
cross-node calls, wrong endpoints/values, future anchors, and due/past endpoints.

These are scheduling-contract proofs. The unchanged native offline automation
test still checks the actual 20 ms linear fade, final zero and sample-step bounds.
The actual browser run separately checks routing, output levels and cleanup.
Neither valid API arguments nor these functional checks certify a hardware fade,
general scheduling latency or runtime acceptance. Runtime remains NOT_CLEARED.
