# Contributing

Thanks for looking. This is a small project with strict invariants; please read this before a PR.

## Build and test

```bash
npm ci
npm run typecheck   # tsc --build
npm run lint        # biome check .
npm run test        # vitest (unit + repo-wide invariants)
npm run build
npm -w packages/extension run test:integration:xvfb   # real VS Code, Linux (needs xvfb)
```

All of `typecheck`, `lint`, `test` must exit 0. Do not pipe them into `tail`; the exit code is the result.

CI runs the four gates plus a tree scan, gitleaks, `vsce package` and an MCP Inspector smoke test on
every push and pull request; the integration suites (Linux, xvfb) and a **non-blocking** Windows run
happen on pull requests. Node's version is decided in one place, `.nvmrc`.

`git config core.hooksPath .githooks` enables the pre-push scan that keeps private paths and
addresses out of the tree (`scripts/release/scan-public-tree.mjs`; CI runs the same scan).

## The invariants

The properties that must not be broken are the ones listed in README "Safety, in one table" and in
`SECURITY.md` — no network listener, no tool returns file contents, `show_code` never moves the
selection, one sanitizer, safety settings only from user scope, a bounded stage. Several of them are
enforced by tests under `test/` that scan the source tree. If your change needs to relax one, say so
explicitly in the PR; it will be discussed before anything else.

## How this repository is developed

This public repository is a **release mirror**: development happens in a private repository, and
each release lands here as a single commit. Issues and
pull requests are welcome and read. A merged contribution is applied to the private repository,
ships in the next release, and is credited in `CHANGELOG.md` — it will not appear as a merge
commit here. Small, focused PRs with tests are the easiest to carry across.

## Pull requests

- One topic per PR. Tests first where the change is behavioral.
- No commit trailers that reference private tooling sessions. `Co-Authored-By:` lines for AI tools are fine — see README "How this was built".
- Strings read by agents (tool descriptions, errors) are English only. Strings read by humans go through `vscode.l10n` with `package.nls.ja.json`.
- Never type bidi-override or zero-width characters; write them as `U+202E`. `test/source-hygiene.test.ts` checks the whole repository including Markdown.

## Reporting a security issue

See `SECURITY.md`. Please do not open a public issue for a vulnerability.
