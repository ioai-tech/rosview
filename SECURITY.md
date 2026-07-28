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

## Dependency vulnerabilities

This repository uses Dependabot for npm and GitHub Actions updates. Runtime impact of `npm audit` findings in **devDependencies** (lint, test, and library packaging tools) is typically limited to maintainer machines and CI; still, high/critical issues in the toolchain are fixed by upgrading or removing the affected packages when practical.

We avoid broad `npm overrides` for security patches when a direct dependency upgrade or removing unused tooling is sufficient.
