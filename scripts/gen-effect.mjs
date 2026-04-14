#!/usr/bin/env node
// Effect scaffolder. Mirrors Sub D's Gain artifacts.
//
// Usage: vp run gen:effect <kebab-name> [--class <PascalName>] [--force]
//
// Writes 5 new files (Rust kernel, TS class, catalog page, Tier2 test,
// Tier3a spec) and inserts 5 marker-anchored lines/blocks into existing
// files (effects/mod.rs, effects index.ts, examples main.ts, worklet
// processor.ts, gen-golden effects.py). All filled with TODO(effect)
// markers — the worker AI completes them per the linked issue.
//
// CLI is intentionally tiny (no commander/yargs) — the script must run
// in a fresh checkout with only `node` available.

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class ScaffoldError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, msg) {
  throw new ScaffoldError(code, msg);
}

export function parseArgs(argv) {
  const args = { name: null, classOverride: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--class") {
      args.classOverride = argv[++i];
      if (args.classOverride === undefined) fail(2, "--class requires a value");
    } else if (a.startsWith("--class=")) {
      args.classOverride = a.slice("--class=".length);
    } else if (a.startsWith("--")) {
      fail(2, `unknown flag: ${a}`);
    } else if (args.name === null) {
      args.name = a;
    } else {
      fail(2, `unexpected positional arg: ${a}`);
    }
  }
  if (!args.name) fail(2, "Usage: gen-effect.mjs <kebab-name> [--class <PascalName>] [--force]");
  return args;
}

// Anchored + non-empty-segment pattern: the TLD between hyphens must contain
// at least one [a-z0-9]. This forbids `foo--bar`, `foo-`, `-foo`, and other
// empty-segment shapes that would otherwise slip past `[a-z][a-z0-9-]*` and
// crash `deriveNames` when an empty segment's `s[0]` is undefined.
const EFFECT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function deriveNames({ name, classOverride }) {
  if (!EFFECT_NAME_RE.test(name)) fail(2, `name must match ${EFFECT_NAME_RE}, got "${name}"`);
  if (classOverride != null && !/^[A-Z][A-Za-z0-9]*$/.test(classOverride))
    fail(2, `--class must match /^[A-Z][A-Za-z0-9]*$/, got "${classOverride}"`);
  const kebab = name;
  const snake = kebab.replace(/-/g, "_");
  const Pascal =
    classOverride ??
    kebab
      .split("-")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join("");
  return { kebab, snake, Pascal };
}

export function templates({ kebab, snake, Pascal }) {
  return {
    [`crates/den-core/src/effects/${snake}.rs`]: `//! ${Pascal} effect. TODO(effect): one-paragraph description and reference URL.

use core::slice;

#[repr(C)]
pub struct ${Pascal}State {
    // TODO(effect): fields required for this effect's state. Default to f64
    // for any smoothed / recursive value (matches Sub D's Gain pattern;
    // f32 hits noise floors faster than the -96 dBFS Tier2 default).
    _placeholder: f64,
}

#[unsafe(no_mangle)]
pub extern "C" fn den_${snake}_size() -> usize {
    core::mem::size_of::<${Pascal}State>()
}

/// # Safety
///
/// \`state\` must be a non-null pointer to a writable [\`${Pascal}State\`]
/// allocation (e.g., obtained from [\`crate::den_alloc\`] with at least
/// [\`den_${snake}_size\`] bytes). Pass null and the function returns a no-op
/// (release-mode safety net for OOM upstream).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn den_${snake}_init(state: *mut ${Pascal}State, sample_rate: f32) {
    if state.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    // TODO(effect): initialize state from sample_rate.
    let _ = sample_rate;
    s._placeholder = 0.0;
}

/// # Safety
///
/// * \`state\` must be a non-null, initialized [\`${Pascal}State\`] pointer.
/// * \`l_in\`, \`r_in\` must each be valid pointers to \`n\` readable \`f32\`s.
/// * \`l_out\`, \`r_out\` must each be valid pointers to \`n\` writable \`f32\`s.
/// * \`p0_values\` must be a valid pointer to \`n_p0_values\` readable \`f32\`s
///   (length 1 for k-rate / a-rate-no-events, length \`n\` for sample-accurate
///   a-rate; never zero in the worklet path).
/// * The four audio regions and the param region must not overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn den_${snake}_process(
    state: *mut ${Pascal}State,
    l_in: *const f32,
    r_in: *const f32,
    l_out: *mut f32,
    r_out: *mut f32,
    n: usize,
    // TODO(effect): one (ptr, len) pair per AudioParam declared in the issue.
    p0_values: *const f32,
    n_p0_values: usize,
) {
    if state.is_null() {
        return;
    }
    if n == 0 {
        return;
    }
    let _s = unsafe { &mut *state };
    let li = unsafe { slice::from_raw_parts(l_in, n) };
    let ri = unsafe { slice::from_raw_parts(r_in, n) };
    let lo = unsafe { slice::from_raw_parts_mut(l_out, n) };
    let ro = unsafe { slice::from_raw_parts_mut(r_out, n) };

    // SAFETY: avoid \`from_raw_parts(null, 0)\` UB. Worklet-side dispatch
    // guarantees \`n_p0_values >= 1\`; guard explicitly so no path constructs
    // a slice from a possibly-null pointer.
    let _p0: &[f32] = if n_p0_values == 0 {
        debug_assert!(false, "den_${snake}_process: n_p0_values must be >= 1");
        &[]
    } else {
        unsafe { slice::from_raw_parts(p0_values, n_p0_values) }
    };

    // TODO(effect): implement DSP loop per cited reference.
    for i in 0..n {
        lo[i] = li[i];
        ro[i] = ri[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TODO(effect): replace with real Tier1 unit tests covering at minimum
    //  - identity-like case (e.g. unity-pass param)
    //  - one known-output case from the cited reference
    //  - one edge case from the issue spec (DC offset, silence, impulse, etc.)
    #[test]
    fn placeholder_size_is_state_size() {
        assert_eq!(den_${snake}_size(), core::mem::size_of::<${Pascal}State>());
    }
}
`,

    [`packages/effects/src/${kebab}.ts`]: `import {
  DEN_PROCESSOR_NAME,
  getCachedWasmBytes,
  registerDenWorklet,
  type RegisterOptions,
} from "@denaudio/worklet";

/**
 * Construction options for the \`${Pascal}\` effect.
 *
 * Note: this interface does NOT extend \`RegisterOptions\`. URL overrides
 * (\`wasmUrl\` / \`workletUrl\`) apply only to the async \`${Pascal}.register(ctx, opts)\`
 * phase; passing them to the sync constructor would silently no-op.
 */
export interface ${Pascal}Options {
  // TODO(effect): typed option fields, one per AudioParam in the issue spec.
  // Example: param0?: number;
}

/**
 * TODO(effect): one-paragraph description matching the issue's summary.
 *
 * Reference: TODO(effect): cite the source the kernel was implemented from.
 */
export class ${Pascal} extends AudioWorkletNode {
  // TODO(effect): one \`readonly <name>: AudioParam\` per parameter.

  /** Idempotency guard for \`dispose()\`; second and later calls no-op. */
  #disposed = false;

  constructor(ctx: BaseAudioContext, options: ${Pascal}Options = {}) {
    const bytes = getCachedWasmBytes(ctx);
    super(ctx, DEN_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // TODO(effect): \`parameterData\` and \`processorOptions\` for any seedable
      // initial values (mirror \`Gain\`'s clamping + \`__denInitialGain\` pattern
      // when the kernel has smoothed state that must start at the user value).
      processorOptions: {
        __denKernelId: "${kebab}",
        __denWasmBytes: bytes,
      },
    });
    void options;
    // TODO(effect): grab each AudioParam via \`this.parameters.get("<name>")\` and
    // assign to the \`readonly\` field above. Throw if missing.
  }

  /**
   * Free WASM-side state and disconnect the node from the audio graph.
   * **Disconnects ALL connections** to/from this node; idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.port.postMessage({ __denCmd: "destroy" });
    this.disconnect();
  }

  /** Idempotent: loads WASM and installs the worklet module on \`ctx\`. */
  static async register(ctx: BaseAudioContext, options: RegisterOptions = {}): Promise<void> {
    await registerDenWorklet(ctx, options);
  }
}
`,

    [`packages/examples/src/pages/${kebab}.ts`]: `import { ${Pascal} } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { renderEffectPage } from "../lib/effect-page.js";

export const name = "${Pascal}";

/**
 * ${Pascal} catalog page. Declarative — all lifecycle, UI scaffolding,
 * source picking, transport, Bypass, AbortSignal teardown, file
 * upload, and AnalyserNode + rAF visualization live in
 * \`lib/effect-page.ts\` (Sub D's canonical helper).
 */
export async function render(root: HTMLElement, signal: AbortSignal): Promise<void> {
  await renderEffectPage(root, signal, {
    title: "${Pascal}",
    description: "TODO(effect): one-line description from the issue.",
    register: (ctx, opts) => ${Pascal}.register(ctx, opts),
    makeNode: (ctx, _params /* TODO(effect): forward initial params */) => new ${Pascal}(ctx, {}),
    // TODO(effect): wire applyParam to forward each slider to the right AudioParam.
    // applyParam: (node, name, value, ctx) => { ... },
    // TODO(effect): one ParamSpec per continuous parameter from the issue.
    params: [
      // { name: "param0", min: 0, max: 1, step: 0.01, initial: 0.5 },
    ],
    bridge: ({ workletUrl }) => {
      window.__denTier3a = { ...window.__denTier3a, ${Pascal}, CANONICAL, workletUrl };
    },
    workletUrl,
  });
}
`,

    [`packages/test-utils/tests/${kebab}.test.ts`]: `/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runGoldenNull } from "@denaudio/test-utils/node";

interface DenCoreExports {
  memory: WebAssembly.Memory;
  den_alloc(n_bytes: number): number;
  den_dealloc(ptr: number, n_bytes: number): void;
  den_${snake}_size(): number;
  den_${snake}_init(state_ptr: number, sample_rate: number): void;
  den_${snake}_process(
    state_ptr: number,
    l_in: number,
    r_in: number,
    l_out: number,
    r_out: number,
    n: number,
    p0_values_ptr: number,
    n_p0_values: number,
  ): void;
}

const SR = 48000;
const wasmBytes = readFileSync(resolve(import.meta.dirname, "../../core/dist/den_core.wasm"));
const mod = new WebAssembly.Module(wasmBytes);

// TODO(effect): map each preset name to its parameter values. MUST match
// \`scripts/gen-golden/effects.py:REGISTRY["${kebab}"].presets\` exactly.
const PRESETS: Record<string, { p0: number }> = {
  default: { p0: 0.0 },
};

function run${Pascal}(stereoIn: Float32Array[], preset: string): Float32Array[] {
  const p = PRESETS[preset];
  if (!p) throw new Error(\`unknown preset \${preset}\`);

  const inst = new WebAssembly.Instance(mod);
  const ex = inst.exports as unknown as DenCoreExports;

  const left = stereoIn[0]!;
  const right = stereoIn[1]!;
  const n = left.length;
  const audioBytes = n * 4;
  // k-rate scratch = single f32. For an a-rate param swap to \`audioBytes\`
  // and copy the full broadcast value (or per-sample envelope) instead.
  const p0Bytes = 4;

  const lp = ex.den_alloc(audioBytes);
  const rp = ex.den_alloc(audioBytes);
  const lo = ex.den_alloc(audioBytes);
  const ro = ex.den_alloc(audioBytes);
  const p0p = ex.den_alloc(p0Bytes);
  const stateSize = ex.den_${snake}_size();
  const sp = ex.den_alloc(stateSize);

  const heap = new Float32Array(ex.memory.buffer);
  heap.set(left, lp >> 2);
  heap.set(right, rp >> 2);
  heap[p0p >> 2] = p.p0;

  ex.den_${snake}_init(sp, SR);
  ex.den_${snake}_process(sp, lp, rp, lo, ro, n, p0p, 1);

  const L = heap.slice(lo >> 2, (lo >> 2) + n);
  const R = heap.slice(ro >> 2, (ro >> 2) + n);

  ex.den_dealloc(lp, audioBytes);
  ex.den_dealloc(rp, audioBytes);
  ex.den_dealloc(lo, audioBytes);
  ex.den_dealloc(ro, audioBytes);
  ex.den_dealloc(p0p, p0Bytes);
  ex.den_dealloc(sp, stateSize);

  return [L, R];
}

await runGoldenNull({
  effect: "${kebab}",
  presets: Object.keys(PRESETS),
  process: run${Pascal},
});
`,

    [`packages/examples/tests/${kebab}.spec.ts`]: `/// <reference types="node" />
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import "../src/test-bridge.js";

// TODO(effect): replace this fixme with a real Tier3a spec modeled after
// \`gain.spec.ts\`. Cover at least 3 (preset, signal) pairs spanning the
// effect's parameter space. The fixme is here so CI signals red until a
// real spec lands — never delete it without replacement.
test.describe("Tier3a: ${Pascal} through AudioWorklet", () => {
  test.fixme("null test against golden — TODO(effect)", async ({ page }) => {
    await page.goto("/#/${kebab}");
    await page.waitForFunction(() => Boolean(window.__denReady));
    void resolve;
    void expect;
  });
});
`,
  };
}

// --- Patches ---------------------------------------------------------------

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeNewFiles(root, tmpls, force) {
  for (const [rel, content] of Object.entries(tmpls)) {
    const full = resolve(root, rel);
    if ((await fileExists(full)) && !force) {
      fail(1, `exists (use --force): ${rel}`);
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    process.stdout.write(`  wrote ${rel}\n`);
  }
}

async function patchInsertBeforeMarker(root, relFile, marker, lineToInsert) {
  // Line-based splice — preserves the marker line's own indentation rather
  // than double-indenting when `marker` happens to be prefixed with spaces
  // in the file (e.g. the `// SCAFFOLDER:INSERT_DISPATCH` inside the
  // processor switch block). `lineToInsert` may be a single line or a
  // multi-line block; it is inserted verbatim (with its own absolute
  // indentation) directly above the first line containing `marker`.
  const full = resolve(root, relFile);
  const src = await readFile(full, "utf8");
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx < 0) {
    fail(1, `marker "${marker}" missing in ${relFile}; cannot scaffold`);
  }
  // Idempotency: skip if the payload is already present verbatim anywhere
  // in the file (signature is unique enough — includes the effect name).
  if (src.includes(lineToInsert.trimEnd())) {
    process.stdout.write(`  patched ${relFile} (no-op, already present)\n`);
    return;
  }
  const payload = lineToInsert.split("\n");
  lines.splice(idx, 0, ...payload);
  await writeFile(full, lines.join("\n"));
  process.stdout.write(`  patched ${relFile}\n`);
}

async function patchExamplesMain(root, snake, kebab) {
  const rel = "packages/examples/src/main.ts";
  const full = resolve(root, rel);
  let src = await readFile(full, "utf8");
  if (!src.includes("// SCAFFOLDER:INSERT_PAGE")) {
    fail(1, `marker "// SCAFFOLDER:INSERT_PAGE" missing in ${rel}`);
  }
  const importLine = `import * as ${snake} from "./pages/${kebab}.js";`;
  if (!src.includes(importLine)) {
    const importRe = /^import \* as [a-zA-Z0-9_]+ from "\.\/pages\/[^"]+";$/gm;
    let lastMatch = null;
    let m;
    while ((m = importRe.exec(src)) !== null) lastMatch = m;
    if (!lastMatch) {
      fail(1, `cannot find existing pages import in ${rel}`);
    }
    const insertAt = lastMatch.index + lastMatch[0].length;
    src = src.slice(0, insertAt) + "\n" + importLine + src.slice(insertAt);
  }
  const entryLine = `  ${snake},`;
  if (!src.includes(entryLine + "\n  // SCAFFOLDER:INSERT_PAGE")) {
    src = src.replace("  // SCAFFOLDER:INSERT_PAGE", entryLine + "\n  // SCAFFOLDER:INSERT_PAGE");
  }
  await writeFile(full, src);
  process.stdout.write(`  patched ${rel}\n`);
}

async function patchProcessor(root, kebab, snake) {
  const block = [
    `      case "${kebab}": {`,
    `        // TODO(effect): copy each AudioParam Float32Array to a WASM scratch ptr,`,
    `        //   then call ex.den_${snake}_process(state, l_in, r_in, l_out, r_out, n, p0, n_p0, ...).`,
    `        // For an effect with state, allocate stateHeapPtr in the constructor`,
    `        // (mirror the gain branch above) and pass it as the first arg.`,
    `        break;`,
    `      }`,
  ].join("\n");
  await patchInsertBeforeMarker(
    root,
    "packages/worklet/src/processor.ts",
    "// SCAFFOLDER:INSERT_DISPATCH",
    block,
  );
}

async function patchScipyRegistry(root, kebab) {
  const block = [
    ``,
    `REGISTRY["${kebab}"] = Effect(`,
    `    name="${kebab}",`,
    `    process=lambda x, **kw: x.copy(),  # TODO(effect): replace with reference impl`,
    `    presets={"default": {}},`,
    `)`,
  ].join("\n");
  await patchInsertBeforeMarker(
    root,
    "scripts/gen-golden/effects.py",
    "# SCAFFOLDER:INSERT_REGISTRY",
    block,
  );
}

// --- Entry point -----------------------------------------------------------

export async function generate({ name, classOverride = null, force = false, root = DEFAULT_ROOT }) {
  const names = deriveNames({ name, classOverride });
  const tmpls = templates(names);
  await writeNewFiles(root, tmpls, force);
  await patchInsertBeforeMarker(
    root,
    "crates/den-core/src/effects/mod.rs",
    "// SCAFFOLDER:INSERT_MOD",
    `pub mod ${names.snake};`,
  );
  await patchInsertBeforeMarker(
    root,
    "packages/effects/src/index.ts",
    "// SCAFFOLDER:INSERT_EXPORT",
    `export { ${names.Pascal} } from "./${names.kebab}.js";`,
  );
  await patchExamplesMain(root, names.snake, names.kebab);
  await patchProcessor(root, names.kebab, names.snake);
  await patchScipyRegistry(root, names.kebab);
  process.stdout.write(
    `\n\u2713 Scaffolded ${names.kebab}. Fill in every TODO(effect):, then:\n` +
      `  vp run gen-golden ${names.kebab}\n` +
      `  vp run test\n`,
  );
}

// CLI invocation guard — skip when imported as a module (e.g., from the test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await generate(args);
  } catch (err) {
    if (err instanceof ScaffoldError) {
      process.stderr.write(`gen-effect: ${err.message}\n`);
      process.exit(err.code);
    }
    throw err;
  }
}

export { DEFAULT_ROOT, ScaffoldError };
