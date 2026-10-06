import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceIdentity } from "./build-den-kit.mjs";
import { assertDraftPreview } from "./build-den-kit-preview.mjs";

test("preview staging rejects production, other branches and missing context before building", () => {
  for (const env of [
    {},
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "feature/den-kit-prototype" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: "feature/den-kit-prototype" },
  ])
    assert.throws(() => assertDraftPreview(env));
  assert.doesNotThrow(() =>
    assertDraftPreview({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature/den-kit-prototype",
    }),
  );
});
test("git-less deployment identity exposes only a validated commit SHA", () => {
  const folder = mkdtempSync(join(tmpdir(), "den-kit-identity-"));
  try {
    const sha = "a".repeat(40);
    assert.deepEqual(
      sourceIdentity(folder, { VERCEL_GIT_COMMIT_SHA: sha, SECRET: "never-output" }),
      { sourceCommit: sha, sourceDirty: null, sourceIdentity: "vercel" },
    );
    assert.throws(() => sourceIdentity(folder, {}));
    assert.throws(() => sourceIdentity(folder, { VERCEL_GIT_COMMIT_SHA: "not-a-sha" }));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
