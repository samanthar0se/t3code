---
name: release-t3code
description: Build, publish, and propagate committed T3 Code changes to the affected server, hosted web, desktop, relay, and mobile release surfaces. Use when the user asks to build, deploy, release, publish, or propagate this repository to remote clients.
---

# Release T3 Code

Plan and execute the smallest production release that safely propagates the committed changes.

## Guardrails

- Run from the repository root on `main`.
- Read `AGENTS.md` and `docs/operations/release.md` before changing release behavior.
- Use only the `samantha-clanker` GitHub App. Start with `~/.local/bin/github-app inspect .`.
- Run GitHub CLI commands as `~/.local/bin/github-app gh . -- <args>`.
- Never request, store, or use a personal GitHub username, password, or token.
- Require a clean working tree. Ask the user to commit or discard changes instead of staging them automatically.
- Do not create a stable release unless the user explicitly supplies and confirms its version. Default propagation uses the nightly channel.
- Before a production push or workflow dispatch, summarize the affected surfaces and proceed only when the current request explicitly authorizes the release. Otherwise ask one focused confirmation question.

## Inspect changes

1. Fetch `origin/main` and tags without prompting for credentials. Resolve the App helper to an absolute path and pass it explicitly:

   ```bash
   GITHUB_APP="${GITHUB_APP:-$HOME/.local/bin/github-app}"
   GIT_TERMINAL_PROMPT=0 git \
     -c credential.helper= \
     -c "credential.helper=!\"$GITHUB_APP\" credential" \
     fetch origin main --tags
   ```

2. Stop if `main` does not contain `origin/main`.
3. Select the newest nightly tag matching `nightly-v*` or `v*-nightly.*`. If none exists, inspect all commits not on `origin/main`.
4. List commits and changed files from that base through `HEAD`.
5. Classify the changes conservatively:
   - **Relay:** `infra/relay/**` or relay deployment configuration.
   - **Unified release:** `apps/server/**`, `apps/web/**`, `apps/desktop/**`, shared packages used by those apps, workspace dependencies, release scripts, or release workflow changes.
   - **Mobile OTA:** JavaScript, TypeScript, or asset changes under `apps/mobile/**`, or shared client code consumed by mobile.
   - **Mobile native build:** native modules, native dependencies, Expo configuration/plugins, entitlements, generated native projects, app version policy, or lockfile changes that alter the native runtime.
   - **No product release:** documentation, tests, agent skills, or development-only configuration with no runtime or packaging effect.
6. Treat unknown runtime-impacting files as affected rather than skipping them.

## Decide whether the server needs a build

The server package is governed by an exact-version invariant:

- Every released hosted-web or desktop client version must have a matching `t3@<exact-version>` package on npm.
- Therefore, a unified release always builds and publishes the server package, even when server source is unchanged. This is a version-alignment build, not necessarily a server-code rebuild.
- A mobile-only OTA or native build does not require publishing a new server version unless shared protocol or server-facing contracts changed.
- A running remote server only needs updating when its advertised version differs from the released client. T3 Code detects that mismatch and offers its supported update/restart action; do not guess or restart unknown remote hosts directly.

Report this decision explicitly as one of:

- `server: required (source changed)`
- `server: required (exact-version alignment)`
- `server: not required (mobile-only or no product release)`

## Verify before pushing

- Run the smallest focused checks for the classified surfaces.
- For a unified release, the GitHub release workflow runs the authoritative lint, typecheck, and test gates; do not duplicate the full workspace suite locally.
- For mobile changes, run focused static or type checks appropriate to the changed files.
- Stop on any relevant failure.

## Push safely

Push with the App helper passed explicitly so Git never falls back to an interactive username prompt:

```bash
GITHUB_APP="${GITHUB_APP:-$HOME/.local/bin/github-app}"
GIT_TERMINAL_PROMPT=0 git \
  -c credential.helper= \
  -c "credential.helper=!\"$GITHUB_APP\" credential" \
  push origin HEAD:main
```

If the push added commits to `main`, locate and watch the matching `deploy-relay.yml` push run. The workflow deploys on every push, including a no-op infrastructure reconciliation. Stop if it fails.

## Dispatch affected releases

Use the pushed `HEAD` SHA to identify each workflow run and watch it with `--exit-status`.

### Unified server, web, and desktop

Dispatch and watch:

```bash
~/.local/bin/github-app gh . -- workflow run release.yml --ref main -f channel=nightly
```

This workflow publishes the exact-version CLI/server package before exposing desktop artifacts and the hosted web deployment. Do not bypass or reorder that dependency.

### Mobile

- For OTA-compatible mobile changes, dispatch `mobile-eas-production.yml` with `mode=update` and `platform=all`.
- For native-runtime changes, dispatch it with `mode=build` and `platform=all` after the OTA workflow. The build is submitted asynchronously to the stores.
- When both apply, run OTA first so compatible installed clients receive changes immediately, then queue native builds.
- Inspect logs after each run. Treat `EXPO_TOKEN is not available; skipping EAS production job` as failure even if GitHub marks the workflow successful.

## Report completion

Include:

- pushed commit SHA;
- changed-file base and affected-surface classification;
- server build decision and reason;
- workflow run URLs and conclusions;
- propagation status: hosted web availability, desktop nightly update availability, mobile OTA status, and native store submission status;
- any remaining user action, such as approving a desktop update or waiting for store review.

Do not claim propagation when a workflow was skipped, failed, or merely queued without stating that distinction.
