# Musical clock seek boundary correction

A native entry probe found that negative tiny finite f32 requests such as -2^-60
and -2^-149 could round to exactly `steps` when wrapped in f64. The old clock
emitted an invalid `step === steps`, `phase === 0` on that seek sample and stored
zero position afterward. This violated the existing `[0,steps)` contract.

The repair clamps only the rounded wrapped position to the immediately preceding
f64 below `steps`, computed at construction as
`steps - 2**(ceil(log2(steps))-53)`. Already-valid wrapped f64 positions retain their
values; no extra f32 seek quantization, state slot, rate change, or API is added.
Exact positive/negative integer boundaries still wrap to their correct step;
negative tiny seeks remain within the final step, with public phase capped below
one under the existing f32 phase contract. This cannot recover precision already
lost when an input f32 was created, and is not arbitrary-precision transport.

`tests/probes/musical-controls-clock-boundary.mjs` preserves a repeatable native
probe. The pre-repair source SHA256 was
`5b9c35ef1ecc9b00d97c649c645179dc25560d81d17b74788e2dd8293c1f6dcd`.
The original output for both -2^-149 and -2^-60 was `(step,phase)=(1,0),(3,0),
(64,0)` for cycles of 1, 3, and 64, in free and tempo mode, with zero position
state at the final seek. The original source, f32 input/output bytes and snapshot
were retained separately before the repair.

`tests/musical-clock-seek.spec.ts` uses exact BigInt f32 units and a bit-adjacent
f64 upper bound as its independent oracle. It covers every fixed step count
1..64, free/tempo modes and extreme tempo divisions, positive/negative integer
neighbors, the input clamp endpoints, tiny negative normal/subnormal requests,
actual native stored position, and identical same-schema snapshot continuation.
Existing modulation/arpeggiator regressions remain required. All native evidence
is CANDIDATE; runtime remains NOT_CLEARED.
