# Bounded uniform convolution candidate

`partitionedConvolution({ blockSize, impulse }).tick(input, reset,
everyNSamples)` uses the existing stride-1 `forSample` scheduler. This is a small
uniform-partition frequency-domain convolution, not a direct FIR relabeled as
FFT processing. It is CANDIDATE and has no human or realtime acceptance.
The initial B<=32 and IR<=128-sample range is a bounded partitioning/FIR proof,
not a practical convolution-reverb or complete catalog §10 capability.

## Contract

- B is a construction-fixed power of two in 4..32; N=2B. The original/fixed IR has
  1..4B taps, each finite in [-1,1], and sum of absolute tap values <=4. Input is
  finite normalized audio [-1,1]; output is not clipped or gain-normalized.
- The IR is split into at most four B-sample partitions, each zero-padded to N.
  Its complex spectra are calculated from the DFT formula at graph construction.
  Runtime uses the internal radix-2 FFT, frequency-delay line, complex products,
  normalized IFFT and overlap-add. No dependency, loader, alternate runtime,
  dynamic allocation, runtime IR update or new snapshot system is introduced.
- At sample t=mB, the previous input block [t-B,t) is transformed. For output
  block m the spectral sum is Σ H_p X_(m-p), then its 2B time samples are added
  to [t,t+2B). Algorithmic latency is exactly B samples. The IR's own leading
  zeros/predelay and tail of L-1 samples are additional, separate properties.
- Reset immediately outputs zero, discards its input sample and pre-reset tail,
  invalidates history and earlier partitions, and preserves native hop phase.
  The partial first block after reset is zero-padded before the reset boundary.
  Held reset remains silent. Flush with B+L-1 zero samples to hear the full tail.
- Fixed f64 buffers use exact 2^128 scaling for input/history/spectra, avoiding
  0.4.1's 1e-30 buffer-write flush discarding f32 subnormal audio. IR coefficients
  are double constants. No treatment of arbitrary nonfinite inputs is promised.
- Persistent history, overlap, spectra and indices use native full snapshots.
  FFT/mixed-spectrum scratch is transient and rewritten before use. Same graph
  and rate are required. Changing IR/configuration requires a new graph; no
  migration, IR swap, crossfade, stereo adapter or long-room support is implied.

## Required evidence

Three-rate direct time-domain FIR comparison covers one tap, partial final
partitions, all partition counts, taps at partition boundaries, random original
IRs, impulse/full tail, all reset hop phases, zero IR and linearity. Snapshot
continuation must be bit-identical, no output scrub is accepted, and instance
memory must stay fixed. Packed consumer and generated-worklet checks remain
separate gates. Measured local cold/warm quantum costs are diagnostic only.
The shared N64 FFT/STFT proof measured a 298-ms cold first quantum locally;
this is a startup hazard, not a runtime-safe building block certification.
