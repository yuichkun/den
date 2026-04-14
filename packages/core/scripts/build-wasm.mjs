#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const CARGO_OUT = resolve(ROOT, "target/wasm32-unknown-unknown/wasm-release/den_core.wasm");
const DIST = resolve(import.meta.dirname, "../dist");
const DIST_WASM = resolve(DIST, "den_core.wasm");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd]);
  return r.status === 0;
}

if (!which("cargo")) {
  console.error("cargo not found. Install Rust: https://rustup.rs");
  process.exit(1);
}
if (!which("wasm-opt")) {
  console.error("wasm-opt not found. Install binaryen:");
  console.error("  macOS: brew install binaryen");
  console.error("  Ubuntu/Debian: sudo apt-get install binaryen");
  console.error(
    "  Windows: scoop install binaryen (or download from https://github.com/WebAssembly/binaryen/releases)",
  );
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

run("cargo", [
  "build",
  "--target",
  "wasm32-unknown-unknown",
  "--profile",
  "wasm-release",
  "-p",
  "den-core",
]);

if (!existsSync(CARGO_OUT)) {
  console.error(`Expected WASM output not found at ${CARGO_OUT}`);
  process.exit(1);
}

run("wasm-opt", [
  "-O3",
  "--enable-bulk-memory",
  "--enable-mutable-globals",
  "--enable-sign-ext",
  "--enable-nontrapping-float-to-int",
  CARGO_OUT,
  "-o",
  DIST_WASM,
]);

console.log(`✓ den_core.wasm written to ${DIST_WASM}`);
