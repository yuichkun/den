// Self-test for scripts/gen-effect.mjs. Uses node --test.
//
// Strategy: copy just the marker-bearing files into a tmp root, then invoke
// the scaffolder's internal `generate()` against that root. Avoids touching
// the real repo and runs in ~100 ms without any build artifacts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import { generate, deriveNames, parseArgs, ScaffoldError } from "./gen-effect.mjs";

// --- Fixtures ---------------------------------------------------------------

const FIXTURES = {
  "crates/den-core/src/effects/mod.rs": "pub mod passthrough;\n// SCAFFOLDER:INSERT_MOD\n",
  "packages/effects/src/index.ts":
    'export { Passthrough } from "./passthrough.js";\n// SCAFFOLDER:INSERT_EXPORT\n',
  "packages/examples/src/main.ts": [
    'import "./styles.css";',
    "",
    'import * as passthrough from "./pages/passthrough.js";',
    "",
    "const PAGES: Record<string, unknown> = {",
    "  passthrough,",
    "  // SCAFFOLDER:INSERT_PAGE",
    "};",
    "void PAGES;",
    "",
  ].join("\n"),
  "packages/worklet/src/processor.ts": [
    "// placeholder",
    "function _process(kernelId: string): void {",
    "  switch (kernelId) {",
    '    case "passthrough":',
    "      break;",
    "    // SCAFFOLDER:INSERT_DISPATCH",
    "  }",
    "}",
    "void _process;",
    "",
  ].join("\n"),
  "scripts/gen-golden/effects.py": "REGISTRY = {}\n\n# SCAFFOLDER:INSERT_REGISTRY\n",
};

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "den-gen-effect-"));
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- Tests ------------------------------------------------------------------

test("deriveNames: naive PascalCase for simple kebab", () => {
  const { kebab, snake, Pascal } = deriveNames({ name: "soft-clip", classOverride: null });
  assert.equal(kebab, "soft-clip");
  assert.equal(snake, "soft_clip");
  assert.equal(Pascal, "SoftClip");
});

test("deriveNames: acronym-friendly --class override", () => {
  const { Pascal } = deriveNames({ name: "eq-3-band", classOverride: "EQ3Band" });
  assert.equal(Pascal, "EQ3Band");
});

test("deriveNames: rejects invalid kebab", () => {
  assert.throws(() => deriveNames({ name: "Soft-Clip", classOverride: null }), ScaffoldError);
  assert.throws(() => deriveNames({ name: "1bad", classOverride: null }), ScaffoldError);
});

test("deriveNames: rejects reserved Rust/TS identifiers", () => {
  // Any reserved word whose snake form is produced verbatim inside
  // `pub mod <snake>;` / `import * as <snake> ...` must be blocked up front.
  for (const bad of ["for", "if", "fn", "let", "in", "do", "mod", "use", "new", "class"]) {
    assert.throws(
      () => deriveNames({ name: bad, classOverride: null }),
      (err) => {
        assert.ok(err instanceof ScaffoldError, `expected ScaffoldError for "${bad}"`);
        assert.equal(err.code, 2);
        assert.match(err.message, /reserved identifier/);
        return true;
      },
    );
  }
});

test("deriveNames: rejects empty-segment kebab (prevents TypeError crash)", () => {
  // Previous regex /^[a-z][a-z0-9-]*$/ accepted these and crashed at split().
  for (const bad of ["foo--bar", "foo-", "-foo", "a--", "a---b"]) {
    assert.throws(
      () => deriveNames({ name: bad, classOverride: null }),
      (err) => {
        assert.ok(err instanceof ScaffoldError, `expected ScaffoldError for "${bad}"`);
        assert.equal(err.code, 2);
        return true;
      },
    );
  }
});

test("deriveNames: rejects invalid --class", () => {
  assert.throws(() => deriveNames({ name: "ok", classOverride: "lowercase" }), ScaffoldError);
});

test("parseArgs: handles flags and positional", () => {
  assert.deepEqual(parseArgs(["foo", "--force", "--class", "Foo"]), {
    name: "foo",
    classOverride: "Foo",
    force: true,
  });
  assert.deepEqual(parseArgs(["foo", "--class=Foo"]), {
    name: "foo",
    classOverride: "Foo",
    force: false,
  });
});

test("parseArgs: missing name exits 2", () => {
  assert.throws(
    () => parseArgs([]),
    (err) => {
      assert.ok(err instanceof ScaffoldError);
      assert.equal(err.code, 2);
      return true;
    },
  );
});

test("parseArgs: unknown flag exits 2", () => {
  assert.throws(
    () => parseArgs(["foo", "--bogus"]),
    (err) => {
      assert.ok(err instanceof ScaffoldError);
      assert.equal(err.code, 2);
      return true;
    },
  );
});

test("generate: writes all 5 files and patches all 5 markers", async () => {
  const root = await makeRoot();
  await generate({ name: "soft-clip", root });

  const expectedFiles = [
    "crates/den-core/src/effects/soft_clip.rs",
    "packages/effects/src/soft-clip.ts",
    "packages/examples/src/pages/soft-clip.ts",
    "packages/test-utils/tests/soft-clip.test.ts",
    "packages/examples/tests/soft-clip.spec.ts",
  ];
  for (const f of expectedFiles) {
    assert.ok(await exists(resolve(root, f)), `missing ${f}`);
  }

  const modRs = await readFile(resolve(root, "crates/den-core/src/effects/mod.rs"), "utf8");
  assert.match(modRs, /pub mod soft_clip;\n\/\/ SCAFFOLDER:INSERT_MOD/);

  const index = await readFile(resolve(root, "packages/effects/src/index.ts"), "utf8");
  assert.match(index, /export \{ SoftClip \} from "\.\/soft-clip\.js";/);

  const main = await readFile(resolve(root, "packages/examples/src/main.ts"), "utf8");
  assert.match(main, /import \* as soft_clip from "\.\/pages\/soft-clip\.js";/);
  assert.match(main, /\n  soft_clip,\n  \/\/ SCAFFOLDER:INSERT_PAGE/);

  const processor = await readFile(resolve(root, "packages/worklet/src/processor.ts"), "utf8");
  assert.match(processor, /case "soft-clip":/);
  assert.match(processor, /den_soft_clip_process/);

  const effects = await readFile(resolve(root, "scripts/gen-golden/effects.py"), "utf8");
  assert.match(effects, /REGISTRY\["soft-clip"\] = Effect\(/);
});

test("generate: --class override is honored everywhere the PascalCase appears", async () => {
  const root = await makeRoot();
  await generate({ name: "eq-3-band", classOverride: "EQ3Band", root });
  const tsClass = await readFile(resolve(root, "packages/effects/src/eq-3-band.ts"), "utf8");
  assert.match(tsClass, /class EQ3Band extends AudioWorkletNode/);
  const index = await readFile(resolve(root, "packages/effects/src/index.ts"), "utf8");
  assert.match(index, /export \{ EQ3Band \}/);
  const page = await readFile(resolve(root, "packages/examples/src/pages/eq-3-band.ts"), "utf8");
  assert.match(page, /import \{ EQ3Band \} from "@denaudio\/effects";/);
  assert.match(page, /new EQ3Band\(/);
  const rust = await readFile(resolve(root, "crates/den-core/src/effects/eq_3_band.rs"), "utf8");
  assert.match(rust, /pub struct EQ3BandState/);
});

test("generate: refuses to overwrite existing file without --force", async () => {
  const root = await makeRoot();
  await generate({ name: "soft-clip", root });
  await assert.rejects(generate({ name: "soft-clip", root }), (err) => {
    assert.ok(
      err instanceof ScaffoldError,
      `expected ScaffoldError, got ${err?.constructor?.name}`,
    );
    assert.equal(err.code, 1);
    assert.match(err.message, /exists \(use --force\)/);
    return true;
  });
});

test("generate: --force overwrites existing file cleanly", async () => {
  const root = await makeRoot();
  await generate({ name: "soft-clip", root });
  await generate({ name: "soft-clip", force: true, root });
});

test("generate: missing marker in target file exits 1 with file path", async () => {
  const root = await makeRoot();
  // Delete the marker in one of the target files.
  const modPath = resolve(root, "crates/den-core/src/effects/mod.rs");
  await writeFile(modPath, "pub mod passthrough;\n"); // no marker
  await assert.rejects(generate({ name: "soft-clip", root }), (err) => {
    assert.ok(err instanceof ScaffoldError);
    assert.equal(err.code, 1);
    assert.match(err.message, /SCAFFOLDER:INSERT_MOD/);
    assert.match(err.message, /mod\.rs/);
    return true;
  });
});

test("generate: patch is idempotent on marker files when new files are rewritten with --force", async () => {
  const root = await makeRoot();
  await generate({ name: "soft-clip", root });
  const modBefore = await readFile(resolve(root, "crates/den-core/src/effects/mod.rs"), "utf8");
  await generate({ name: "soft-clip", force: true, root });
  const modAfter = await readFile(resolve(root, "crates/den-core/src/effects/mod.rs"), "utf8");
  assert.equal(modBefore, modAfter, "marker-anchored patch should not duplicate on second run");
});
