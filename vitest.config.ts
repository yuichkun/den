import { defineConfig } from 'vitest/config';
// WASM compilation/rendering is CPU-heavy; avoid contention in the combined suite.
export default defineConfig({test:{include:['tests/*.spec.ts'],maxWorkers:1}});
