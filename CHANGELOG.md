# Changelog

Release pull requests add a dated version section here, with breaking changes
and migration instructions first. Unreleased entries do not imply npm availability.

## Unreleased

## 0.2.0 — 2026-11-12

- **Breaking:** requires `@unworklet/core` **0.6.0**. Update the compiler, offline
  renderer, Vite plugin and test helpers to 0.6.0 together. Node 24 is unchanged.
- **Breaking:** pass `ctx.renderQuantumSize` to spectral framing, convolution,
  spatial-chain and resident time-stretch construction configs. Their dispatch
  periods now preserve saved hop phase at the actual quantum boundary. Rebuild
  processors for the target context; old or cross-target snapshots are not a
  supported migration path.
- FFT and spectral work-buffer loops use `forIndex` instead of assuming that an
  audio loop always runs 128 samples. Transform and partition sizes retain their
  existing sample-based meaning.
- The playground uses the actual AudioContext sample rate and render quantum
  (128 on browsers without `renderQuantumSize`) for worker compilation, metadata
  and schema identity. It no longer forces or requires 48 kHz.
- The spectral-freeze example waits for input before filling its capture history,
  so delayed source setup cannot freeze an empty startup buffer.
- Add multi-rate and multi-quantum spectral regression coverage, including
  continuation after snapshots at non-128 boundaries. Dependency regression
  checks now exercise the upstream fixes included in 0.6.0.
- Audio remains CANDIDATE. This compatibility update does not grant human
  listening approval or clear the existing real-time capacity limitations.

### Migrating construction configs

Add `renderQuantumSize: ctx.renderQuantumSize` inside the `defineProcessor(ctx =>
...)` callback when constructing `stftIdentity`, `spectralGate`, `spectralFreeze`,
`spectralBlur`, `spectralCrossSynthesis`, `partitionedConvolution`,
`preparedConvolution`, `residentTimeStretch`, `hybridReverb` or
`feedforwardPitchedReverb`. For example:

```ts
// Inside the existing defineProcessor(ctx => { ... }) callback:
const stft = instantiate(stftIdentity, {
  size: 256, hopSize: 128, renderQuantumSize: ctx.renderQuantumSize,
}, { name: 'stft' });
```

Host-side `prepareConvolutionSpectrum` and its `PreparedConvolutionConfig` keep
their existing shape; the DSP constructor uses `PreparedConvolutionRuntimeConfig`.
Frame lengths, partition lengths, latency in samples and control sampling times
retain their meaning. Native scheduler counters are not snapshot state, so
dispatch uses a divisor of both hop and quantum; smaller or non-dividing quanta
can perform more FFT/search work. This is functional support, not a new
real-time performance guarantee.

## 0.1.0 — 2026-10-09

- First public npm release of `@denaudio/den`, with 54 ESM module entry points,
  TypeScript declarations, public DSP documentation and MIT OR Apache-2.0 licensing.
- Requires the tested `@unworklet/core` peer dependency at `0.4.1`.
- Add release-PR automation, npm trusted publishing, package-boundary checks and
  version preparation for the package and its locked consumers.
- The initial DSP catalog remains CANDIDATE. See
  [catalog status](docs/catalog-status.md) and
  [initial acceptance](docs/initial-acceptance.md) for validation boundaries.
