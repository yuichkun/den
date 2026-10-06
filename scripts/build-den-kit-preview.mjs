import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDenKit } from "./build-den-kit.mjs";
const root = resolve(import.meta.dirname, "..");

export function assertDraftPreview(env = process.env) {
  if (env.VERCEL_ENV !== "preview" || env.VERCEL_GIT_COMMIT_REF !== "feature/den-kit-prototype") {
    throw new Error(
      "den-kit is Draft-only: this build requires its exact preview branch and refuses production.",
    );
  }
}

export function stageDenKitPreview() {
  assertDraftPreview();
  const built = buildDenKit();
  const output = join(root, "den-kit-preview-dist");
  try {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    cpSync(built.output, output, { recursive: true });
    writeFileSync(
      join(output, "provenance.json"),
      JSON.stringify(
        {
          application: "den-kit-prototype",
          target: "preview",
          ...built.provenance,
        },
        null,
        2,
      ),
    );
    return output;
  } finally {
    rmSync(built.consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built Draft-only den-kit Preview: ${stageDenKitPreview()}`);
}
