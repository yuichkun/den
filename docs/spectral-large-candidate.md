# Larger STFT offline candidate

The reviewed initial proof at `262d74b` remains frozen. After independent review
of the private large-frame proof at `cea9dfe`, this follow-up promotes the public
`stftIdentity` wrapper to power-of-two N in8..1024, with H=N/2 or N/4. This is an
offline candidate with explicit snapshot and execution-cost contracts.
Convolution remains B<=32 and IR<=128 samples.

## Kernel proof

N1024 now uses counted native loops for initialization/bit reversal, butterfly
stages and buffer copies. Eight complex test vectors at each of 44.1/48/96 kHz
cover impulse, DC, Nyquist, positive/negative bins, off-bin tone and seeded
complex/real data. Forward/inverse results match a direct O(N²) DFT rounded to
the f32 output format within 1e-6; signs, ordering, normalization and real-input
conjugate symmetry are checked independently.

A fresh frozen-head N1024 kernel-only probe completed under the unchanged
2-GiB/90-second watchdog: 114,709-byte WASM, 128-KiB fixed memory, 188-MB process
RSS peak and 15.82-ms first quantum. This is a kernel diagnostic, not evidence
for windowed framing, snapshots, practical concurrency or realtime acceptance.

## Persistent frame phase

Public unworklet 0.4.1 has no condition-driven statement block. Its select is
eager; everyNSamples/byN bounds are construction-fixed. Native everyNSamples
counters are omitted from snapshots. Simply changing a hop to256 or512 would
therefore change its phase when restoring a snapshot taken at an intermediate
128-sample quantum boundary.

The candidate uses native dispatch every min(H,128) samples, a divisor of the
snapshot quantum. Its existing named persistent ring cursor determines whether
cursor modulo H is zero. Only these true H-phase frames update overlap state
and consume pending-reset invalidation. Reset never changes cursor/hop phase.

For H>128 the FFT/IFFT pair still executes every128 samples. Off-phase results
are discarded using eager selects; this is expressly not H-rate CPU savings.
Window, history and spectrum scratch use explicit buffer indices, with no
implicit audio/parameter sample position inside nested work loops.

## Verified so far

- Original small FFT/WOLA/FIR tolerances and reset/latency assertions unchanged
- N256/512/1024 identity reconstruction at H=N/2 and N/4, all three rates
- Every reset phase, separated sufficiently to yield nonzero reconstructed audio
- Exact N-sample latency and reset's current-input discard
- All four quantum-offset phase classes for H<=512, including reset immediately
  before snapshots; continuation is bit-identical
- Held reset, varying signed f32 subnormals and full finite f32 range, zero scrubs
- 29 focused tests passed in26 seconds, with502-MB observed process-tree RSS

## Measured eager-dispatch profile

The actual internal N1024/H512 STFT dispatches every128 samples and completed a
fresh-process 48-kHz profile under the unchanged2-GiB/60-second watchdog in2.22s.
It generated119,327 bytes of WASM, used128KiB fixed DSP memory and peaked at194MB
process RSS. Capture was97ms, compile1.60s and first/startup maximum18.98ms.
After128 warmup quanta,512 measured quanta had process p50 0.163ms,
p99 1.428ms and maximum4.680ms; maximum including copies was4.687ms. Zero output
scrubs and fixed memory were checked. This is one local Node instance with host
jitter, not browser or concurrency evidence.

Both the cold and observed warm maxima exceed the2.67-ms 48-kHz quantum.
The algorithmic audio latency is separately1024 samples:21.33ms at48kHz,
23.22ms at44.1kHz and10.67ms at96kHz. Choosing H512 does not reduce execution to
once every512 samples: preserving arbitrary-quantum snapshot phase currently
costs one FFT/IFFT pair per128 samples, with off-phase results discarded.

An isolated public packed consumer verifies the actual export, both N1024 hops,
three offline rates, reset and all four snapshot phase classes, plus the
generated48-kHz Vite worklet. Exact-head package evidence and final independent
QA gate integration of this promotion. No browser, human sound or realtime clearance is
claimed. This does not complete pitch/time processing, phase-vocoder effects or
practical long-IR convolution.
