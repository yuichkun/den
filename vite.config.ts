// Root Vite+ config. The library packages have their own `vite.config.ts`
// with the actual `build` blocks; the root config is here purely so that
// `vp check` and `vp lint` can pick up workspace-level `lint.options`.
//
// `typeAware` + `typeCheck` enable Vite+'s type-aware Oxlint path so
// `vp check` actually runs the TypeScript-aware analysis (without these,
// `vp check` only runs format + non-type-aware lint and silently passes
// real TS errors). See https://viteplus.dev/guide/check.
export default {
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
};
