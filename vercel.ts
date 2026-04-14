import { type VercelConfig } from "@vercel/config/v1";

// Mirrors the dashboard configuration so settings don't silently drift.
// The Vercel native GitHub integration reads this file at build time
// (https://vercel.com/docs/project-configuration/vercel-ts).
export const config: VercelConfig = {
  installCommand: "./scripts/vercel-install.sh",
  buildCommand: "./scripts/vercel-build.sh",
  outputDirectory: "packages/examples/dist",
  framework: null,
};
