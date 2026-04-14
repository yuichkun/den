/// <reference types="node" />
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { assertNullBelow } from "./null.js";
import { CANONICAL } from "./signals.js";
import { readWavF32 } from "./wav.js";

export interface RunnerOptions {
  effect: string;
  tolerance?: number;
  // Presets to validate. Default ["default"].
  presets?: string[];
  // Signal names to validate. Default = every key in CANONICAL. Each
  // (preset, signal) pair must have a matching golden WAV or the runner
  // exits with `missing golden: ...`. Per issue #4 §7.2, deleting a
  // single golden file must cause the runner to fail, so we iterate over
  // the expected set rather than whatever happens to be on disk.
  signals?: string[];
  process: (signal: Float32Array[], preset: string) => Promise<Float32Array[]> | Float32Array[];
}

export async function runGoldenNull(opts: RunnerOptions): Promise<void> {
  const root = resolve(import.meta.dirname, "../golden", opts.effect);
  if (!existsSync(root)) {
    throw new Error(`missing golden directory: ${root} — run \`vp run gen-golden ${opts.effect}\``);
  }
  const tol = opts.tolerance ?? -96;
  const presets = opts.presets ?? ["default"];
  const signals = opts.signals ?? Object.keys(CANONICAL);
  for (const preset of presets) {
    for (const signalName of signals) {
      const sigFactory = CANONICAL[signalName];
      if (!sigFactory) {
        throw new Error(
          `unknown signal "${signalName}" — add it to signals.ts CANONICAL or drop it from opts.signals`,
        );
      }
      const goldenPath = resolve(root, `${preset}__${signalName}.wav`);
      if (!existsSync(goldenPath)) {
        throw new Error(`missing golden: ${goldenPath} — run \`vp run gen-golden ${opts.effect}\``);
      }
      const golden = readWavF32(goldenPath);
      if (golden.sampleRate !== 48000) {
        throw new Error(
          `sample rate mismatch: golden=${golden.sampleRate}, runtime=48000 (${goldenPath})`,
        );
      }
      if (golden.numChannels !== 2) {
        throw new Error(
          `channel count mismatch: golden=${golden.numChannels}, runtime=2 (${goldenPath})`,
        );
      }
      const monoIn = sigFactory();
      const stereoIn = [monoIn, monoIn];
      const actual = await opts.process(stereoIn, preset);
      assertNullBelow(actual, golden.samples, tol, `${opts.effect}/${preset}/${signalName}`);
      console.log(`  ✓ ${opts.effect}/${preset}/${signalName}`);
    }
  }
}
