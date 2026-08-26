# Release Process

This document describes how to cut a new release of `@ioai/rosview`.

Publishing is fully automated: once you push a version tag, GitHub Actions handles building, testing, npm publishing, and creating the GitHub Release with auto-generated notes.

---

## Prerequisites

- You must have push access to the `main` branch and tag creation rights.
- **npm Trusted Publishing** must be configured for `@ioai/rosview` on [npmjs.com](https://www.npmjs.com):
  - Publisher: **GitHub Actions**
  - Organization or user: `ioai-tech`
  - Repository: `rosview`
  - Workflow filename: `release.yml`
  - Allowed actions: **npm publish**
- Tags must be pushed to **`ioai-tech/rosview`** (GitHub-hosted runners only).
- npm CLI **≥ 11.5.1** (Node 24 in CI satisfies this).

---

## Step-by-step release procedure

### 1. Bump the version in package.json

```bash
npm version 1.2.0 --no-git-tag-version
# or edit package.json "version" field directly
```

### 2. Commit the release changes

```bash
git add package.json package-lock.json
git commit -m "chore: release v1.2.0"
```

### 3. Push and tag

```bash
git push
git tag v1.2.0
git push origin v1.2.0
```

### 4. Monitor the workflow

Go to **Actions** tab on GitHub and watch the `Release` workflow:

| Job | What it does |
|-----|-------------|
| `validate` | Runs lint, unit tests, full SPA build, and library build |
| `publish-npm` | Publishes `@ioai/rosview` to npm via Trusted Publishing (OIDC) |
| `github-release` | Creates a GitHub Release with GitHub auto-generated release notes |

If any job fails, fix the issue and re-push the tag:

```bash
git tag -d v1.2.0          # delete local tag
git push origin :v1.2.0    # delete remote tag
# fix the problem...
git tag v1.2.0
git push origin v1.2.0
```

---

## Versioning policy

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

| Change type | Version bump | Example |
|-------------|-------------|---------|
| Bug fix (no API change) | Patch | `1.0.0` -> `1.0.1` |
| New feature (backward-compatible) | Minor | `1.0.0` -> `1.1.0` |
| Breaking API change | Major | `1.0.0` -> `2.0.0` |

**Breaking changes** are any modifications to the symbols exported from `src/entrypoints/index.ts` that require consumers to update their code (renamed props, removed exports, changed types).

### Pre-release versions

Use npm pre-release suffixes for beta or release-candidate builds:

```bash
npm version 1.2.0-beta.1 --no-git-tag-version
git tag v1.2.0-beta.1
git push origin v1.2.0-beta.1
```

The release workflow automatically marks releases as **pre-release** on GitHub when the tag name contains a hyphen (e.g., `v1.2.0-beta.1`).

---

## npm authentication

Publishing uses **Trusted Publishing** (OIDC) — no `NPM_TOKEN` secret is required for
`npm publish`. If CI ever needs to install private npm dependencies during `npm ci`,
use a separate **read-only** token via `NPM_READ_TOKEN` on the install step only.
