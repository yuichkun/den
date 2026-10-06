import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(import.meta.dirname, "..");
export function sourceIdentity(cwd = root, env = process.env) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (resolve(top) === resolve(cwd))
      return {
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
        sourceDirty:
          execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() !== "",
        sourceIdentity: "git",
      };
  } catch {}
  // Vercel can omit .git. Whitelist only its documented public commit identity;
  // never serialize the environment or treat an invalid/missing SHA as proven.
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha))
    throw new Error("A verified git or Vercel commit SHA is required.");
  return { sourceCommit: sha.toLowerCase(), sourceDirty: null, sourceIdentity: "vercel" };
}
/** Isolated packed app. Never stages site-dist or changes deployment settings. */
export function buildDenKit() {
  const consumer = mkdtempSync(join(tmpdir(), "den-kit-consumer-"));
  const run = (args, cwd = consumer) =>
    execFileSync("npm", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  try {
    cpSync(join(root, "den-kit"), consumer, {
      recursive: true,
      filter: (path) =>
        !["node_modules", "dist", "candidate-provenance.json"].includes(basename(path)),
    });
    const [pack] = JSON.parse(run(["pack", "--json", "--pack-destination", consumer], root));
    copyFileSync(join(consumer, pack.filename), join(consumer, "den.tgz"));
    const provenance = {
      status: "CANDIDATE",
      ...sourceIdentity(),
      packageIntegrity: pack.integrity,
    };
    writeFileSync(join(consumer, "candidate-provenance.json"), JSON.stringify(provenance, null, 2));
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    lock.packages["node_modules/@denaudio/den"].integrity = pack.integrity;
    writeFileSync(join(consumer, "package-lock.json"), JSON.stringify(lock, null, 2));
    run(["ci", "--include=dev", "--ignore-scripts"]);
    run(["run", "check"]);
    execFileSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "test/graph.test.mjs",
        "test/audio.test.mjs",
        "test/host.test.mjs",
      ],
      { cwd: consumer, encoding: "utf8", stdio: "inherit", timeout: 120000 },
    );
    run(["run", "build"]);
    return { consumer, output: join(consumer, "dist"), provenance };
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    rmSync(consumer, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildDenKit();
  console.log(`Isolated den-kit prototype: ${result.output}`);
  console.log("Draft review artifact only; not deployed.");
}
