import type { DelayFxConfig, DelayFxControls } from './delay-fx.js';

/** Values for existing delayFx inputs, not a serialization or parameter registry. */
export type DelaySettingsValues = {
  readonly [K in keyof DelayFxControls]: K extends 'sync' | 'bypass' | 'reset' ? boolean : number;
};
export interface DelaySettings {
  readonly config: Readonly<Omit<DelayFxConfig, 'sampleRate'>>;
  readonly parameters: DelaySettingsValues;
}

/** CANDIDATE: short, opposite-phase motion blended with the original signal. */
export const chorusSettings = {
  config: { maxDelaySeconds: 2, tone: 'flat', stereoPhaseCycles: 0.5 },
  parameters: {
    timeLeftSeconds: 0.018, timeRightSeconds: 0.018,
    sync: false, bpm: 120, beatsLeft: 1, beatsRight: 1,
    feedback: 0, cutoffHz: 3200, mix: 0.45,
    rateHz: 0.65, depthSeconds: 0.003, bypass: false, reset: false,
  },
} as const satisfies DelaySettings;

/** CANDIDATE: dotted eighth left, quarter right; tone acts only on feedback. */
export const rhythmicDelaySettings = {
  config: { maxDelaySeconds: 2, tone: 'lowpass', stereoPhaseCycles: 0.5 },
  parameters: {
    timeLeftSeconds: 0.375, timeRightSeconds: 0.5,
    sync: true, bpm: 120, beatsLeft: 0.75, beatsRight: 1,
    feedback: 0.48, cutoffHz: 3200, mix: 0.35,
    rateHz: 0, depthSeconds: 0, bypass: false, reset: false,
  },
} as const satisfies DelaySettings;
