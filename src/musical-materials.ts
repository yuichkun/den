/** Original synthetic materials and ordinary native AudioParam values.
 * These are CANDIDATE examples, not a preset format or listening-approved audio.
 * Asset creation runs on the host before the native `load` message is sent.
 */
export const musicalMaterialsStatus = 'CANDIDATE' as const;

export const glassDyadParameters = {
  gateA: 0, gateB: 0, frequencyA: 220, frequencyB: 330,
  frame: .25, gain: .2, reset: 0,
} as const;
export const glassDyadBrightParameters = { ...glassDyadParameters, frame: 1.75 } as const;
export const glassDyadConstruction = { voices: 2, frameLength: 128, frameCount: 3, capacity: 384 } as const;
/** Three complete 128-sample cycles, no duplicate endpoint; fixed weights, no normalization. */
export function makeGlassDyadTable(): Float32Array {
  return Float32Array.from({ length: 384 }, (_, n) => {
    const phase = 2 * Math.PI * (n % 128) / 128;
    const frame = Math.floor(n / 128);
    return frame === 0 ? .8 * Math.sin(phase)
      : frame === 1 ? .6 * Math.sin(phase) + .2 * Math.sin(2 * phase)
      : .4 * Math.sin(phase) + .25 * Math.sin(2 * phase) + .15 * Math.sin(3 * phase);
  });
}

export const fmModalHitParameters = {
  gate: 0, strength: .8, ratio: 1.5, deviationHz: 100, modalMix: .35, gain: .22, reset: 0,
} as const;
export const fmModalHitBellParameters = { ...fmModalHitParameters, ratio: 2.75, deviationHz: 170, modalMix: .7 } as const;
export const fmModalHitModes = [
  { frequencyHz: 220, decaySeconds: .42, gain: 1 },
  { frequencyHz: 351, decaySeconds: .24, gain: .6 },
  { frequencyHz: 563, decaySeconds: .15, gain: .35 },
] as const;

export const grainCloudParameters = {
  gate: 0, positionFrames: 512, jitterFrames: 240, rate: 1,
  durationSeconds: .09, densityHz: 16, gain: .28, reset: 0,
} as const;
export const grainCloudReverseParameters = {
  ...grainCloudParameters, positionFrames: 2800, rate: -.75,
  durationSeconds: .12, densityHz: 12,
} as const;
export const grainCloudConstruction = { capacity: 4096, sourceSampleRate: 48000, maxGrains: 2, seed: 1741 } as const;
/** Original periodic tone cluster with a smooth fixed amplitude contour.
 * Integer cycle counts make the short resident loop continuous. No recorded audio.
 */
export function makeGrainCloudSample(): Float32Array {
  return Float32Array.from({ length: 4096 }, (_, n) => {
    const phase = 2 * Math.PI * n / 4096;
    const contour = .55 - .45 * Math.cos(phase);
    return contour * (.32 * Math.sin(19 * phase) + .17 * Math.sin(31 * phase) + .08 * Math.sin(47 * phase));
  });
}

export const shapedEchoParameters = {
  drive: 2.4, cutoffHz: 1800, delaySeconds: .125, feedback: .25,
  mix: .3, gain: .2, reset: 0,
} as const;
export const shapedEchoDarkParameters = {
  ...shapedEchoParameters, drive: 4.5, cutoffHz: 650, delaySeconds: .1875, mix: .45,
} as const;
