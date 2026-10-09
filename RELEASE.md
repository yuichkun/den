# Releasing den

den follows [unworklet's release-PR model](https://github.com/yuichkun/unworklet/blob/main/RELEASE.md):
prepare and review a release pull request, then merging it runs verification,
tags the checked commit, publishes `@denaudio/den` and creates a GitHub Release.
Ordinary PRs, including the automation setup PR, do not publish anything.

## Prepare a release

1. Start from current `main` on a same-repository branch named `release/vX.Y.Z`.
   Use plain version numbers; prereleases and `0.0.0` are not release targets.
2. Run `npm run release:version -- X.Y.Z`. This updates the root package and
   lockfile, plus the four local-tarball consumer locks. It does not change
   dependency resolutions, create a tag, commit, push or publish.
3. Add `## X.Y.Z — YYYY-MM-DD` to `CHANGELOG.md`. Put breaking changes and their
   migrations first. Review `npm run release:pack` and its file list in
   `artifacts/release/manifest.json`.
4. Open the PR, title it `vX.Y.Z — <headline>`, and use its description for public
   release notes. Include an upgrade paragraph when needed and a link to
   `https://github.com/yuichkun/den/blob/vX.Y.Z/CHANGELOG.md`.
5. Wait for all checks, review the latest source and audition relevant audio
   changes. Bring the branch up to date with `main` and review again if it changes.
   Merge only when the release is ready to publish.

Before 1.0, breaking changes increment the minor version; compatible changes
increment the patch. The first intended release is `0.1.0`. Keep unworklet at
the currently tested `0.4.1`; upgrading it is a separate compatibility change.

CI success and npm publication do not promote any CANDIDATE audio to an approved
golden or clear the documented 4-voice real-time limitation. Audio approval stays
attached to its source and audio hashes.

## What automation verifies

The Release workflow runs only for merged `release/v*` PRs from `yuichkun/den`
itself. It checks out the merge commit named by npm provenance and checks that:

- its tree equals the PR's final reviewed tree and it belongs to `main`;
- all package/consumer versions match the branch and the changelog has an entry;
- an existing tag points to the same commit and no newer release supersedes it.

It then calls the complete existing Entry gate on that exact merge commit:
numerical tests, isolated packed consumers, real browser rendering, catalog and
playground completion checks. Those jobs have read-only permissions. Only after
they pass does the publishing job rebuild from a fresh checkout, clear stale
`dist`, inspect the packed files, recheck source/tags and verify npm access.

Only the publishing job has `contents: write` and `id-token: write`. It uses
GitHub-hosted runners and npm OIDC with provenance; there is no `NPM_TOKEN` or
`NODE_AUTH_TOKEN` secret. The verified tarball is published without rerunning
lifecycle scripts. PR titles and notes are passed as data, not shell code.

The package contains ESM, declarations, the existing public `docs`, README,
changelog and both licenses. Tests, workflows, release scripts, lockfiles, source
and playground files are excluded. The public exports are unchanged.

The website's deployment policy is independent of this npm workflow.

## One-time maintainer setup

Do these after reviewing the automation PR and when ready for the first release.
Nothing below needs to be performed to open or test the setup PR.

1. **npm ownership:** sign in with your own npm account, enable 2FA and create or
   obtain publishing rights in the `denaudio` organization. The package name is
   `@denaudio/den`; checking that the package is absent does not prove scope ownership.
2. **Create the new package's settings without publishing the first real release:**
   from a clean checkout of the merged setup (still version `0.0.0`), run:

   ```sh
   npm ci
   npm run release:pack
   npm login
   npx --yes npm@11.21.0 stage publish --access public
   npx --yes npm@11.21.0 stage list @denaudio/den
   ```

   Record the stage ID. npm creates a **public `0.0.0-stage` placeholder** while
   keeping the staged `0.0.0` package contents unavailable. Leave that stage
   pending; **do not approve it**. This reserves a different version from the
   workflow's first `0.1.0`. If the package already exists under your control,
   skip this bootstrap. The newer CLI is needed only for these staging commands;
   Node 24.19.0's npm 11.9.0 already supports the workflow's direct OIDC publish.
3. **npm → package Settings → Trusted publishing:** add GitHub Actions with:

   | Field | Value |
   | --- | --- |
   | Organization or user | `yuichkun` |
   | Repository | `den` |
   | Workflow filename | `release.yml` (no directory) |
   | Environment | Leave empty; this workflow does not name one |
   | Allowed actions | Enable direct `npm publish`; stage-only is insufficient |

   Complete the first workflow publication within **2 days** of configuring the
   publisher; otherwise recreate the expired configuration when ready.
4. **GitHub:** ensure Actions is enabled and repository policy allows this
   workflow's explicit content-write/OIDC permissions. Protect `main` with review
   and the Entry gate checks, require release PRs to be up to date, and ensure
   tag rules allow the workflow to create `v*` tags. No bot PAT or npm token is
   needed, and no auto-merge setting is required.
5. **First real release:** prepare and review `release/v0.1.0` as above, then merge
   it. Confirm the npm version's provenance, GitHub tag and Release. Afterwards
   reject the unused bootstrap stage with
   `npx --yes npm@11.21.0 stage reject <stage-id>` (2FA). Keep token publishing
   disabled in the package's publishing-access settings once OIDC works.

The bootstrap procedure uses npm's documented support for publishing a different
version while a stage is pending. It is a manual account setup step; the PR's
tests do not perform live staging or publishing. References:
[trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[staged publishing](https://docs.npmjs.com/staged-publishing/),
[stage commands](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

## Failure and retry

Merge release PRs one at a time. Runs are serialized without canceling an active
release; GitHub can replace an older pending run when another is queued.

Fix account/runner failures and rerun the failed Release workflow. It keeps a tag
only if it points at the same commit, skips an npm version only if its tarball
integrity matches exactly, and skips an existing GitHub Release. Registry errors
are failures, not evidence that a version is available to publish. A newer tag
or npm version prevents an old run from moving `latest` backwards.

If the reviewed tree differs from the merge, no release is created: prepare a
fresh release PR from current `main` and review it again. Published versions are
immutable; different published bytes require a new version, never a force tag
or replacement. Re-running cannot repair incorrect release notes automatically.
