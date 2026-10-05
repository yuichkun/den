# Prepared-spectrum convolution candidate

`@denaudio/den/prepared-convolution` exports `preparedConvolution`, the host-only
`prepareConvolutionSpectrum`, and `PreparedConvolutionConfig` /
`PreparedConvolutionPacket`. This is an offline-validated **CANDIDATE**, without
browser, realtime-capacity or human-audition clearance.

## Fixed boundary

- Mono, block size B=128, FFT N=256, P=64 partitions. Configuration must be exactly
  `{ blockSize: 128, partitions: 64 }`; unsupported configurations throw.
- Original IR: 1..8192 finite real taps, each in [-1,1], with absolute sum <=4.
  No normalization, truncation, sample-rate conversion or output limiter.
- Audio input must be finite and normalized to [-1,1]. Output can exceed unity.
- Nominal latency is 128 samples: 2.902 ms at 44.1 kHz, 2.667 ms at 48 kHz,
  1.333 ms at 96 kHz. IR leading zeros and its own tail are additional.
- Maximum original IR duration is 185.76 / 170.67 / 85.33 ms at those rates.
  This is a bounded cabinet/body/short-space candidate, not arbitrary long-IR
  room convolution. The existing small `partitionedConvolution` is unchanged.
- The nominal target is original direct FIR delayed by B. Quantized spectra
  introduce small bounded circular/padding leakage, so exact onset/support
  zeros and exact original-IR gain are not promised after quantization.

## Host preparation and native delivery

Call `prepareConvolutionSpectrum(impulse, config)` outside audio processing.
Accepted inputs are arrays, Float32Array or Float64Array. Invalid input/config
and excessive reconstruction error throw RangeError; the helper never changes
IR gain to make an asset pass.

The returned native packet contains:

| Field | Value |
| --- | --- |
| formatVersion | 1 |
| blockSize | 128 |
| partitions | 64 |
| impulseFrames | Original integer length, 1..8192 |
| declaredValues | 32768 |
| spectrum | Float32Array, exactly 32768 values |

Bin k of partition p starts at `2*(p*256+k)`, real then imaginary. Forward sign
is `exp(-i*2*pi*k*n/256)`, without normalization. Each original partition has
128 taps followed by 128 zeros. Unused partitions are zero. Preparation enforces
conjugate symmetry, exact zero DC/Nyquist imaginary components, and Float32
rounding. The returned packet remains mutable: send it **unchanged**.

The caller explicitly declares a native event and forwards its graph payload:

```ts
import { CAPACITY_16, event, instantiate } from '@unworklet/core';
import {
  preparedConvolution, type PreparedConvolutionPacket,
} from '@denaudio/den/prepared-convolution';

const convolver = instantiate(preparedConvolution,
  { blockSize: 128, partitions: 64 }, { name: 'convolver' });
const ir = event<PreparedConvolutionPacket>({
  from: 'main', name: 'ir', capacity: CAPACITY_16, payloadCapacity: 131072,
});
ir.onReceive(packet => convolver.load(packet));
// Inside stride-1 forSample: convolver.tick(input, reset, everyNSamples).
```

No event, loader, acknowledgement or asset-file abstraction is created by the
module. The caller uses existing native host message facilities and owns IR
sample-rate conversion. Native transport can truncate oversized typed arrays:
validate type and length before enqueueing. The independent declaredValues
field detects accidental truncation only when it truthfully states original
length; it cannot authenticate a forged packet.

The native handler checks format/capacity/frame count/decoded length and scans
all 32768 components for NaN, infinity and abs(component)>4. This is malformed
number protection, **not** inverse-domain IR/L1/symmetry/provenance validation.
Correctness and error claims require the unchanged host-prepared packet.

## Approximation certificate

Host preparation independently reconstructs each quantized partition through a
direct inverse DFT over all 256 samples. It sums absolute real error from the
original zero-padded partition plus absolute imaginary residual over every
partition/sample, adds a 1e-8 host numerical guard, and rejects above 4e-6.
The numerical guard is conservative relative to the measured modulo-reduced
host DFT error; this is not a formal cross-engine bound on JavaScript Math.

For any output block phase, the two overlapping input blocks select complementary
halves of each circular error impulse. With |input|<=1 their total error is at
most that partition's reconstruction L1 error. This includes quantized padded-
half leakage and circular wrap, rather than assuming those values remain zero.
The independent test also checks the looser spectral estimate
`2B * sum_p(max_k(complexMagnitude(deltaH[p,k])))`.

A Float32 quantization sanity estimate from Parseval/Cauchy-Schwarz is
`sqrt(N)*2^-24*sum_p(L1(partition[p]))`, at most 3.815e-6 for N256/L1<=4,
plus the absolute subnormal term `P*sqrt(2*N)*2^-150` (about 1.02e-42).
The per-asset inverse-domain certificate remains the actual rejection gate.

Native arithmetic/history/FFT/products/OLA use Float64, coefficients use
Float32, and input/history are scaled by exact 2^128 to preserve signed
subnormal audio against core 0.4.1's tiny-state flushing. Output is Float32.
Tiny IR coefficients can quantize to zero; **no relative tiny-IR accuracy** is
promised. A preparation certificate is not a proof of native arithmetic error.

Acceptance tests separately target native-vs-quantized-operator absolute error
<1e-6 and original-FIR error <5e-6. These are measured test targets, **not a
universal total-error guarantee**. Corresponding 4.000005 gain headroom is a
practical test budget, not a proven bound for every implementation/environment.

## Load, reset, state and scheduling

`tick(input, reset, everyNSamples)` returns `{ output, loaded, rejected,
revision }`. Call it once per sample inside stride-1 native forSample. This
implementation requires the core 0.4.1 128-sample quantum.

- Valid full packet: loaded=true, rejected=false. A shorter IR still carries
  the complete padded 32768-value table, so previous coefficients are replaced.
- Explicit unload: matching format/B/P, impulseFrames=0, declaredValues=0 and
  empty Float32Array. loaded=false, rejected=false.
- Malformed load: loaded=false, rejected=true; no prefix is accepted as an IR.
- Every load attempt, including rejection/unload, increments wrapping i32
  revision. Compare for inequality rather than ordering. Do not round-trip
  revision through an f32 audio channel if exact i32 identity matters.
- Every attempt invalidates old input/spectrum history and OLA tail without
  resetting cursor/hop phase. A valid load accepts the next audio sample.
- Reset keeps the IR and revision, discards its own input sample, invalidates
  history/tail and preserves phase. Held reset is silent. Release resumes with
  nominal B latency. Reset never causes sample-scheduler rephasing.
- Missing/unloaded/rejected assets are silent. Invalidation is logical, not
  secure erasure; bytes may remain in buffers/snapshots until overwritten.

FFT+64-partition MAC+IFFT+OLA run eagerly once every 128 samples, including while
unloaded. Indices are explicit; native counted loops avoid graph expansion by
P*N. B equals quantum size, so the dispatch phase is identical at every native
snapshot boundary. Named persistent cursor, spectral cursor, valid counts,
coefficients/status/revision, histories and overlap fully describe continuation.
Same-graph/config/rate native snapshots continue bit-identically. Pending queued
messages, cross-configuration migration and live-swap crossfades are outside
this contract. Transient FFT/mix buffers are overwritten before use.

## Loading and resource costs

The native coefficient table is 128 KiB, complex input history 256 KiB, and
16-slot native payload ring 2 MiB. Scratch/history/OLA, scalar state and I/O add
more; use the complete packed profile for actual fixed WASM memory.
Sixteen queued loads copy 2 MiB and scan 524288 coefficient components at one
boundary. Preparation allocates host arrays and performs direct DFT/certificate
work outside the callback. Native copy/scan occurs during audio message dispatch,
not outside the callback. Preload with audible playback gated off. postMessage
fallback may allocate. No allocation-free-loading, realtime live-swap or
concurrent-instance capacity claim is made.

The public core driver has no message-ingress method. The packed profile
therefore reports unloaded full-loop cold/warm quantum cost separately from
loaded one-quantum `renderOffline` end-to-end cost for 0/1/16 queued packets.
End-to-end includes instantiate, enqueue, copy/scan, DSP, I/O and snapshot; it is
not an isolated handler measurement. Do not infer audio deadline clearance from
those timings. Complete measured numbers are recorded with exact source and
package hashes in the packed artifact manifest.

## Evidence

- Three-rate focused tests: full8192 impulse tails, dense original FIR,
  independent quantized circular operator, complex transfer, superposition,
  all128 reset offsets/rate, held reset, malformed→unload→short replacement,
  wrapped i32 revision and signed subnormal input.
- 24 focused and 21 packed bit-identical snapshot continuations across
  load/reject/unload/short replacement and reset states; zero output scrubs.
- Separate native Float32 full-capacity entry and host precision probes retain
  independent assertions. The earlier Float64 failure is preserved as a manual
  red reproduction: core 0.4.1 payload.length seals the field as Float32 even
  after Float64 copy, reporting twice the intended element count. No upstream
  dependency patch or byte reinterpretation is used.
- Packed public typecheck, actual native-message render and Vite worklet build.
  Test audio is CANDIDATE; no human approval or browser realtime clearance.

The preliminary packed gate passed in16.23 s (759 MB process-group peak RSS).
At48 kHz its fresh local profile recorded26,747-byte WASM and2,555,904 bytes
fixed memory, including the2 MiB payload ring. Unloaded full-loop cold quantum
was2.063 ms; startup maximum4.218 ms; warm512-quantum p50/p99/max including
I/O copies was0.142/0.539/2.141 ms. Dense8192-tap host preparation was58.6 ms.
The16-load one-quantum offline end-to-end median/max was6.244/11.178 ms.
These measurements include host jitter and do not establish an audio deadline
guarantee; in particular the startup maximum exceeds the48 kHz deadline.

Packed three-rate original-FIR error was2.235e-8 and full impulse error5.372e-9.
The first focused run passed all14 tests in24.15 s with677 MB process-group peak RSS.
Measured dense original-FIR error was1.027e-9, native-vs-quantized operator
8.808e-10, superposition2.329e-9, complex transfer6.597e-8 at all three rates.
