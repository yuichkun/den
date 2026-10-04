import { defineConfig } from 'vitest/config';
// WASM compilation/rendering is CPU-heavy; bound contention in the combined suite.
export default defineConfig({test:{include:['tests/*.spec.ts'],maxWorkers:2}});
