# Spectral framing candidate

This lane is CANDIDATE. It is an FFT/framing and identity reconstruction entry
proof for catalog §10/11, not completion of pitch/time, phase-vocoder, long-IR,
freeze/shimmer or spectral-source work. No human sound approval or browser
realtime clearance is implied.

## Entry contract

`stftIdentity({ size, hopSize, renderQuantumSize: ctx.renderQuantumSize }).tick(input, reset, everyNSamples)` is an ordinary
unworklet subgraph. Instantiate it once with an explicit name. Call tick exactly
once per sample from stride-1 `forSample((i, everyNSamples) => ...)`. The last
argument is unworklet's existing conditional scheduler, not a den scheduler or a
runtime JavaScript callback. `select` is never used to skip the FFT workload.

- Pass the enclosing processor's `ctx.renderQuantumSize` in the configuration.
  It is a positive integer, matching unworklet's compile target, not the FFT size
  or hop. All STFT-based modules use this value for snapshot-safe dispatch.
- Supported N is a power of two in 8..1024. H is N/2 or N/4. These are
  offline-candidate bounds, not a performance or concurrency recommendation.
- The internal, non-public complex radix-2 kernel has natural-order real/imaginary
  planes, forward exponent -i2πkn/N, inverse exponent +i2πkn/N and inverse scale 1/N.
  All intermediate work/history use fixed f64 buffers; I/O is f32. The stream
  uses an exact 2^128 scale internally to avoid 0.4.1's 1e-30 buffer-write
  flush discarding quiet f32 inputs. Stage JavaScript loops execute during
  graph construction. Within each stage, the public `forIndex(count)` loop
  visits exactly the work-buffer capacity, independently of the render quantum,
  without audio/parameter reads or updates to sample time. The outer `forSample`
  loop alone follows the audio quantum. Twiddle step constants are calculated at build
  time, then a bounded f64 recurrence reanchors to (1,0) at every butterfly group.
- A frame at sample t=mH consumes samples [t-N,t), with absent history set to
  zero. It is added to output samples [t,t+N). Output therefore has exactly N
  samples of latency, including startup. Drain with at least N zero input samples.
- Both windows are periodic sqrt-Hann: w[n]=sqrt(0.5-0.5 cos(2πn/N)). The product
  is Hann. For K=N/H in {2,4}, the shifted cosines sum to zero, so the sum of
  squared windows is K/2=N/(2H). The synthesis scale is its reciprocal 2H/N.
- Reset is level-sensitive: it emits zero immediately, discards the current
  input, and invalidates prior history and overlap. Held reset remains silent.
  It does not restart the native hop phase. The first later frame clears stale
  overlap; output is masked until then. Post-reset reconstruction retains the
  same N-sample delay. Discontinuities from reset are intentional.
- Input must be finite f32. No smoothing, gain normalization beyond WOLA, bypass,
  dry/wet routing, sample-rate converter, hidden loader, external FFT runtime,
  or new storage/snapshot system is supplied.
- Native persistent history/overlap/cursor/valid/reset state is saved. FFT and
  spectral scratch are transient and fully overwritten at each scheduled frame.
  Only identical graph/rate/quantum full-snapshot continuation is in scope;
  migration and cross-rate or cross-quantum continuation are not promised.
  Native hop counters are not included in snapshots. Dispatch therefore occurs
  every `gcd(H, 128, renderQuantumSize)` samples, a divisor of both the hop and
  every block-atomic restore boundary. The persistent cursor modulo H selects
  frame commits. Off-phase FFT results are computed eagerly and discarded.
  At quantum 128 this retains the former dispatch period. For H>=128, quantum
  32 evaluates four times as many FFT pairs per sample; a quantum coprime to
  128 dispatches every sample, up to 128 times the old workload. Correct output
  and snapshot phase do not imply realtime feasibility. See
  [large-frame evidence](spectral-large-candidate.md) for historical costs.

## Verification required before integration

Independent direct O(N²) DFT covers complex impulse, DC, Nyquist, positive and
negative bins, off-bin tone, seeded inputs, signs, natural ordering, conjugate
symmetry and inverse normalization. Independent time-indexed DFT/WOLA covers
startup, every hop phase, held/arbitrary resets, block boundaries and three
offline rates (44.1/48/96 kHz). The rate/quantum matrix includes quantum
32/128/256, independent numerical oracles and exact quantum-128 PCM comparisons.
Exact same-schema snapshots include non-128-aligned boundaries at quantum 32
and non-power-of-two quantum 48. Reset discard is checked separately. Larger construction sizes require measured capture/compile
cost, WASM size, memory and quantum-burst timing before becoming public bounds.

Node driver measurements describe that environment only, including whether copies
were included. They do not certify browser deadlines, concurrency or a device
budget. The playground now compiles for its actual AudioContext sample rate and
render quantum using unworklet 0.6.0; this does not grant realtime clearance.

## Initial local evidence

The initial N8/16/32/64 FFT/identity suite passed at all three rates, including
all reset hop phases, native snapshots and quiet/full-range finite f32 input.
For one N64/H16 instance in Node 24, capture was 32 ms, compile 1.16 s, generated
WASM 314,881 bytes, fixed WASM memory 65,536 bytes. A 512-quantum warmed run had
process p99 0.525 ms and maximum 1.07 ms, excluding input/output copies.

**Cold first-quantum execution was 298 ms.** This far exceeds a 48-kHz quantum
and is an explicit startup/deadline hazard. No deployment/realtime clearance is
granted by the warmed result. The exact-head packed report supersedes these
initial diagnostic values; larger frames need separate evidence.

### Graph-shape corrections and current verification

The original fully unrolled kernel is retained in commit `8d3df3c` for
reproduction. At N256/H64, a fresh two-transform driver probe generated 1.61 MB
of WASM, took 12.22 s for its first quantum and peaked at 4.21 GB process RSS.
The fixed DSP allocation was still only 64 KiB. This host compilation/execution
scaling failure is distinct from audio-buffer capacity; the unrolled N1024
probe was deliberately not started.

The first reduction put butterfly stages in native fixed loops. Its independent
hop7 entry probe confirms four inner work-buffer iterations, sequential
write/read visibility and preservation of the outer sample index at all three
rates. The full 16 FFT/STFT/convolution tests still pass. For N64/H16, generated
WASM falls to 84,607 bytes, fresh first quantum to 31.6 ms and peak process RSS
to 179 MB. Warm process p99 is 0.279 ms, maximum 0.395 ms in that local run.
This is a measured reduction, not a deadline clearance: the first quantum still
greatly exceeds the 2.67-ms 48-kHz deadline. The same partial reduction at N256
produced 273 KB WASM, a 110-ms first quantum and 466 MB peak process RSS. Its
N1024 diagnostic was stopped by the external 2-GiB RSS watchdog during the first
quantum: 1.122 MB WASM had compiled, but no cold/warm render completed. This was
not a successful N1024 render or numerical verification.

The current second reduction also uses native indexed loops for FFT
initialization/bit reversal, spectrum copies and STFT overlap-add. The window is
generated by a reanchored f64 sine recurrence each frame, rather than N copies
of graph code. This is still the same periodic sqrt-Hann contract. No audio or
parameter access occurs inside an inner buffer loop; all indices are explicit.

All original small-size DFT, WOLA and direct FIR assertions remain unchanged.
Together with three additional N256 direct-DFT cases, all 19 tests passed in
10.5 seconds. The larger test compares f32 outputs with independently f32-rounded
direct DFT values; it does not broaden public module support. The test process
tree's RSS was unavailable to that run's supervisor, so no zero-memory or peak
memory claim is made for it. Final exact-head resource/packed evidence is a
separate gate. The later independently reviewed large-frame proof and public
packed promotion extend STFT alone to N<=1024; B<=32/IR<=128 convolution bounds
remain unchanged. At N1024/H512 the measured first quantum was18.98ms and warm
maximum4.687ms with copies, both above a48-kHz quantum. Longer IRs and all
realtime claims remain unadvertised.
