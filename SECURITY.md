# Security Policy

## Supported versions

Security fixes are applied to the latest published release of `@ioai/rosview` on npm. Older versions may not receive backports; please upgrade when possible.

## Reporting a vulnerability

Please report security issues responsibly:

- Prefer emailing the maintainers at an `@io-ai.tech` address (see `CONTRIBUTING.md` / `LICENSE` for project ownership), **or**
- Use [GitHub Security Advisories](https://github.com/ioai-tech/rosview/security/advisories/new) for private disclosure when available.

Do **not** open a public GitHub issue for vulnerabilities that could be exploited before a fix is released.

Include as much detail as you can: affected version, reproduction steps, impact, and any suggested remediation.

We aim to acknowledge reports within a few business days and will coordinate a fix and disclosure timeline with you.

## Dependency model (published package)

`@ioai/rosview` is a **pre-bundled** ESM component. The npm tarball contains `dist-lib/` only.

| Kind | Packages | Who installs them | Security meaning |
|---|---|---|---|
| **Peer dependencies** | `react`, `react-dom`, `three` | The host app (required) | Host lockfile / their upgrades. We keep these external so the host has a single React and a single `three`. |
| **Bundled runtime** | Foxglove/MCAP codecs, Dockview, Radix, `sql.js`, `js-yaml` (via `@foxglove/rosbag2`), `protobufjs`, `fflate` (direct), etc. | **Nobody extra** — compiled into `dist-lib` | Advisories in these packages are **runtime** for the SPA and for embedders. They do **not** appear in the host `npm ls` graph. A fix ships only when we rebuild and publish. |
| **Toolchain** | Vite, ESLint, TypeScript, Playwright, Autoprefixer, api-extractor, … | Maintainers and CI | Affects this repo’s install and builds, not the published widget, unless a tool is accidentally bundled. |

Consequences:

- `npm audit --omit=dev` on **this** repository is not a product-security signal: there are no `dependencies`, so the command is always empty.
- Audit the full lockfile (`npm audit`). CI runs `npm run check:audit`, which fails on high/critical findings unless the advisory is waived in [Dependency vulnerabilities](#dependency-vulnerabilities) below.
- Do **not** move bundled libraries into `dependencies` to make Dependabot treat them as production. That would install a second copy in every host app and is the usual way a fat UI widget breaks downstream lockfiles.
- Hosts should not add Dockview, MCAP, Foxglove, Radix, or similar “so rosview works”; those are already inside the bundle.

## Overrides

npm applies `overrides` only from the **root** project. Ours do not leak into embedder lockfiles.

- `@foxglove/rosmsg`: `^5.0.5` — `@foxglove/rosbag@0.4.1` declares `rosmsg ^4`; the rest of the tree uses rosmsg 5. The override keeps a single parser in the library/SPA build.

Prefer a parent-range update (`npm update <nested-pkg>`) over a new override. Add an override only when a parent’s semver range cannot reach a patched release. Do not use a global override that would hoist a nested package across a major (for example do not force `three-stdlib`’s `fflate@^0.6` onto `0.8`).

## Dependency vulnerabilities

This repository uses Dependabot for npm and GitHub Actions updates. Version updates run monthly, grouped as peer stack, bundled runtime, and toolchain so a compiler bump cannot block a codec patch. Semver-major version bumps are not opened automatically; those are dedicated migrations. Security updates still open as soon as an advisory applies.

High/critical issues are fixed by upgrading the affected package when the parent range allows it, or with a narrow override when it does not. Toolchain-only findings that cannot be reached without an unsafe major bump may be waived in this file with the advisory id and the reason.

### Waivers

A waiver is the advisory id plus the reason, kept in the table below. `npm run check:audit` reads this section as its allowlist, so an id deleted from here starts failing CI again. Keep the table short, keep it toolchain-only, and delete entries as soon as a fix exists — a stale waiver is a silent hole.

| Advisory | Chain | Why there is no fix yet | Review |
|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `tailwindcss@3` → `chokidar`, `fast-glob`, `micromatch` → `braces` | `braces` is affected in every published release (latest is 3.0.3), so no override can reach a patch. npm's only suggested fix installs `tailwindcss@4`, a deferred major migration (see the Dependabot policy). Build-time watcher/glob tooling only; nothing in `dist-lib` imports any of it. | Re-check on the monthly Dependabot run; drop when Tailwind 4 lands or `braces` publishes a patch. |
