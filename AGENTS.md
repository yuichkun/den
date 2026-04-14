# AGENTS.md

> **このファイルは消さないでください。絶対に。**
> Agents working on this repo: if you find yourself wanting to delete or rename this file, you are about to make a mistake. Stop and ask the human first.

## About

`den` is a high-quality audio effects library for the Web Audio API, compiled from Rust to WebAssembly and wrapped in AudioWorklet. Distributed as `@denaudio/*` npm packages.

---

## 0. 絶対的な運用ルール (READ THIS FIRST / 最初に読むこと)

This project is **Issue-First** and **Spec-First**. Every line of code lands in response to a GitHub issue whose body is the authoritative specification. The specs are long on purpose — they include decisions, rejected alternatives, fallbacks, and out-of-scope lists so that an automated agent never has to guess.

If you are an AI agent (Cursor cloud agent, Claude Code, Codex, or any other) working on this repo, the following rules are **not negotiable**. Treat them as hard constraints that override any other instinct you have to "improve" or "clean up".

### 0.1 Never deviate from the issue without explicit human approval

- The issue linked to the PR (and its parent epic, if any) is the **single source of truth** for scope, behavior, file paths, exported symbols, CI configuration, package structure, and test shape.
- If the code you are about to write does **not** appear literally or by clear derivation in the issue body, **STOP**.
- "Clear derivation" means: the issue tells you to implement X, and X trivially requires Y (e.g. an import statement). It does **NOT** mean: "a reasonable engineer would also add Z here."
- If you think the issue has a bug, a gap, or a better way — you may be right, but you still do **not** act on it. Leave a comment on the PR (or on the issue) describing the concern and **wait for human approval** before changing course.

### 0.2 No self-judgment. When in doubt: stop, document, ask.

- Do **not** introduce new packages, new files, new npm dependencies, new cargo dependencies, new CI jobs, new scripts, new config files, new type shims, new abstractions, or new fallbacks that are not named in the issue.
- Do **not** silently "adapt" a code snippet in the issue to work around a compiler error, a lint warning, or a type error. If the literal snippet in the issue doesn't compile, that is a **Fallback** situation — see 0.3.
- Do **not** change file names, directory names, export names, function signatures, or CI step names even by one character if the issue specifies them.
- Do **not** delete files you didn't create in this PR, especially not `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `LICENSE-*`, `.github/**`, or anything outside your stated scope.
- If the issue is silent on something and you genuinely need to make a choice, the answer is: **write a comment on the PR describing the choice and the alternatives, then stop and wait**. Do not commit your choice.

### 0.3 Fallbacks are permitted only when named in the issue's "Fallback Plans" section

- Every issue template in this repo includes a section (typically "§8 Fallback Plans" or similar) that enumerates the **only** permitted ways to deviate from the happy path.
- If a fallback applies (e.g. "if wasm-opt isn't installable, skip the opt step"), you may use it, but you **must** note in the PR description which fallback was used and why.
- If what you need is **not** an enumerated fallback, you do **not** have a fallback. Stop and ask.

### 0.4 "Out of Scope" means out of scope — permanently, not "for now"

- Every issue has a "§4 Out of Scope" section listing things the PR must not touch.
- Out-of-scope items are not TODOs, not stretch goals, not "while we're here" improvements. Leave them alone. Another issue will handle them.
- Concrete examples (non-exhaustive, from past scope violations):
  - Refactoring code not touched by the issue.
  - Adding tests beyond what the issue asks for.
  - Upgrading dependency versions unrelated to the scope.
  - Adding type-checking shims, ambient `.d.ts` files, or type utility packages not in the issue.
  - Creating new workspace packages (e.g. `@webaudio/types` is an example of a package that should **not** have been added unless the issue explicitly lists it in `pnpm-workspace.yaml`).

### 0.5 Every line in the PR must be traceable to the issue

Before opening a PR, for every file you added or changed, ask yourself: **"Which bullet in the issue body authorizes this change?"** If you cannot answer for a file, either remove the file or document explicitly in the PR description why it was needed and flag it as "needs human review before merge".

### 0.6 Report deviations honestly in the PR description

- If you were forced to deviate (used a fallback, had to restructure code to make CI green, etc.), **say so explicitly** in the PR description, naming:
  1. What the issue said.
  2. What you did instead.
  3. Why the literal spec did not work.
  4. Which fallback clause (if any) authorized the deviation.
- Do **not** hide deviations by phrasing them as "cleanup" or "tweaks".

### 0.7 When CI is red, fix the root cause. Don't weaken checks.

- Do not comment out tests, loosen lint rules, skip steps, add `--no-verify`, add `continue-on-error`, or add broad exception handlers to make CI green.
- If the issue's literal CI configuration is wrong (e.g. specifies a tool that isn't on the runner), use a fallback if one exists, otherwise stop and ask.

### 0.8 For this repo specifically: tooling is **Vite+** (`vp`), not `pnpm` / `npm` / `yarn` / `npx`

- **Never** invoke `pnpm`, `npm`, `yarn`, `npx`, or `pnpx` directly — not in shell, not in `package.json` scripts, not in CI steps, not in config files like `playwright.config.ts`, not in README commands.
- Use the `vp` equivalents (`vp install`, `vp add`, `vp exec`, `vp run`, `vp dlx`, `vp build`, `vp test`, `vp check`, `vp fmt`, `vp lint`). See the VitePlus docs at https://viteplus.dev/ or `node_modules/vite-plus/AGENTS.md` if installed.
- The `packageManager` field in `package.json` names `pnpm@10.33.0` — that is _only_ so Vite+ knows which pnpm version to bundle internally. It is **not** a license to call `pnpm` directly.
- Direct `pnpm`/`npm` usage is a hard failure on CI because `pnpm` is not on the runner's `PATH` (Vite+ manages it internally). This has already burned us once.

### 0.9 If you are an agent and you don't know how to do something with `vp`, STOP

Don't fall back to `pnpm`. Don't fall back to `npm`. Don't "just use `npx` for this one thing". Read `node_modules/vite-plus/AGENTS.md`, or fetch https://viteplus.dev, or ask the human. Falling back to pnpm because you were unsure is the single most common way agents break this repo.

### 0.10 If you are a reviewer AI (codex auto-review, Claude review, any review sub-agent)

Your job is to **verify against the spec**, not against your instincts. The diff and commit messages are not enough on their own.

1. **Read the linked issues first.** Run `gh issue view <N> --repo yuichkun/den` for every issue this PR references — typically the "Closes #N" target plus its parent epic and any "Blocked by" / "Blocks" siblings. Read this `AGENTS.md`. Read the PR body's "Deviations" / "§0.6 disclosure" block. Only then look at the diff.
2. **Treat the issue body as a literal checklist.** Walk every item in §4 (Out of Scope), §6 (Implementation Plan), §7 (Testing & Verification), §8 (Fallback Plans), and §9 (Definition of Done) against what the diff actually does. Cite `file:line` evidence for each judgment.
3. **Flag every silent deviation.** Each deviation must be either (a) an enumerated §8 fallback that the PR description cites, or (b) explicitly disclosed in the PR body per §0.6. If it is neither, surface it as a blocker — even when the change "looks reasonable". Do not invent fallbacks; fallback authority comes from the issue's §8, not from the PR.
4. **Past failure modes worth a direct check:** any direct `pnpm` / `npm` / `yarn` / `npx` / `pnpx` invocation anywhere — shell, `package.json` scripts, CI steps, config files, READMEs (§0.8); new workspace packages, new files, type shims, npm/cargo deps, or CI jobs not authorized by the issue (§0.2, §0.4); restructuring of files whose shape the issue specifies in §6 (§0.1).
5. **Before approving, name what you walked.** State which issue sections you read end-to-end and what concrete evidence convinced you each DoD item was satisfied. A bare "LGTM" without that grounding is not a useful review and will be treated as if no review happened.

---

## 1. Required tools

Install these before doing anything else.

| Tool                  | Version | Install                                                                        |
| --------------------- | ------- | ------------------------------------------------------------------------------ |
| Rust (stable)         | 1.85+   | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y`     |
| wasm32 target         | —       | `rustup target add wasm32-unknown-unknown`                                     |
| rustfmt + clippy      | —       | `rustup component add rustfmt clippy`                                          |
| binaryen (`wasm-opt`) | 129+    | `sudo apt-get install -y binaryen` (or `brew install binaryen`)                |
| Vite+ (`vp` CLI)      | latest  | `curl -fsSL https://vite.plus \| bash`                                         |
| Node.js               | 22.x    | managed by Vite+ via `.node-version`                                           |
| pnpm                  | 10.33.0 | bundled with Vite+ (do **not** install separately, do **not** invoke directly) |

## 2. Validation loop

Before opening a PR, every agent must run and pass:

```bash
# Rust gates — den-core is `#![no_std]` + wasm32-only, so it's checked
# separately from the rest of the workspace (which includes the std-using
# den-reference binary).
cargo fmt --all -- --check
cargo clippy --workspace --exclude den-core --all-targets -- -D warnings
cargo clippy -p den-core --target wasm32-unknown-unknown -- -D warnings
cargo check --workspace --exclude den-core --all-targets
cargo check -p den-core --target wasm32-unknown-unknown

# JS / TS gates
vp run build              # builds WASM + all @denaudio/* packages
vp check                  # fmt + lint (+ typecheck if enabled in lint.options)
vp run smoke              # Node-side WASM smoke (see scripts/smoke.mjs)
```

If any of these fail on your branch but pass on `main`, the regression is yours to fix. Do not disable the check.

## 3. When in doubt

Re-read the issue. Then re-read this file. Then ask the human.
