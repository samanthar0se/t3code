# GitHub App authentication for an AI-only developer machine

_Research date: 2026-07-26. Sources are GitHub's documentation and the
candidate tools' own repositories._

## Conclusion

This is feasible, but GitHub does not provide a first-party, machine-wide
switch that transparently changes every local Git and GitHub client to a
GitHub App installation identity.

The reliable design has three independent parts:

1. **GitHub API actor:** mint a fresh installation access token and inject it
   as `GH_TOKEN` for every `gh` process (and as the equivalent bearer token for
   other API clients).
2. **Git push authentication:** use HTTPS remotes and a Git credential helper
   that mints a fresh installation token on demand.
3. **Commit attribution:** separately configure Git's author and committer
   name/email as the App's bot user.

For a dedicated AI machine or OS account, a small local token broker plus
wrappers is the most complete architecture. For the Git transport portion,
[`AmadeusITGroup/gh-app-auth`](https://github.com/AmadeusITGroup/gh-app-auth)
or
[`bdellegrazie/git-credential-github-app`](https://github.com/bdellegrazie/git-credential-github-app)
can avoid writing that helper from scratch. Neither GitHub nor a mature
third-party tool discovered in this research provides a proven,
all-clients-on-the-machine solution by itself.

## The three identities are not interchangeable

| Concern                                    | What determines the identity                  | What the App token changes                                                                         |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| REST/GraphQL actions, such as opening a PR | Bearer token used for the request             | An installation token attributes accepted API activity to the App                                  |
| Fetch/push authorization                   | HTTPS credential used by Git                  | The installation token authorizes access within the installation's repository and permission scope |
| Commit author/committer shown on commits   | Name and email embedded in each commit object | Nothing; push credentials do not rewrite commits                                                   |

GitHub explicitly recommends installation authentication when activity should
be attributed to the App. It also notes that some REST endpoints do not accept
installation tokens, so App authentication is not a universal substitute for
a user token in every `gh` command.
([GitHub: authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation))

GitHub's own `actions/create-github-app-token` example makes the separation
clear: it sets `user.name` and `user.email` for the bot and then configures
authentication independently. Its bot identity recipe is:

```text
user.name  = <app-slug>[bot]
user.email = <bot-user-id>+<app-slug>[bot]@users.noreply.github.com
```

The numeric bot user ID is obtained from `GET /users/<app-slug>[bot]`.
([official Action: configure Git CLI for an App's bot user](https://github.com/actions/create-github-app-token#configure-git-cli-for-an-apps-bot-user))

Existing commits retain their embedded author/committer fields. Changing the
push token or machine Git configuration only affects future operations.

## Official mechanisms and their limits

### Installation access tokens

An App signs a short-lived JWT with its private key and exchanges that JWT for
an installation access token. The installation token:

- expires after one hour;
- can be narrowed to a subset of the installation's repositories (up to 500
  named repositories per request);
- can be narrowed to fewer permissions than the installation has, but never
  expanded beyond it; and
- belongs to one installation. A machine that accesses repositories owned by
  multiple organizations/users needs to select the correct installation and
  mint a separate token for each.

([GitHub: generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app))

A static token saved in a machine environment variable, `gh` credential store,
Git Credential Manager, or `~/.git-credentials` will stop working in about an
hour. Refresh must happen at command/credential-request time.

The App private key is the durable credential. GitHub calls it the App's most
valuable secret, recommends a vault with sign-only access where possible, and
warns that an attacker who can read it gains persistent App authentication.
([GitHub: managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps))

### `gh` CLI

For GitHub.com, `gh` checks `GH_TOKEN` and then `GITHUB_TOKEN`; these environment
variables take precedence over stored credentials.
([`gh help environment`](https://cli.github.com/manual/gh_help_environment))

Therefore, the safe local pattern is:

```text
gh-app-wrapper:
  determine OWNER/REPO and its installation
  mint/reuse a token that is not near expiry
  set GH_TOKEN only in the child process
  exec the real gh command
```

Persisting an installation token with `gh auth login --with-token` is a poor
fit because the token expires. The official login documentation describes
`--with-token` in terms of a classic PAT and recommends environment injection
for constrained/headless tokens.
([`gh auth login`](https://cli.github.com/manual/gh_auth_login))

`gh auth setup-git` only configures Git to call `gh` as a credential helper. It
does not mint or refresh App tokens.
([`gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git))

### Git fetch and push

Installation tokens support **HTTP-based Git**, provided the App has repository
`Contents` permission (`write` is needed to push). GitHub documents the
username as `x-access-token` and the installation token as the password.
([GitHub: HTTP Git with an installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation))

The practical global configuration is a Git credential helper scoped to
`https://github.com` (preferably further scoped by owner/repository) with
`credential.useHttpPath=true`. The helper should derive the owner/repository
from Git's credential request, select the matching installation, and return a
fresh token.

SSH remotes bypass HTTPS credential helpers and cannot use an installation
token. On a dedicated AI account, rewrite the common SSH URL forms to HTTPS or
convert remotes:

```text
git@github.com:OWNER/REPO.git
ssh://git@github.com/OWNER/REPO.git
             ↓
https://github.com/OWNER/REPO.git
```

Do not embed the token in remote URLs: it leaks through configuration, command
history, logs, and process inspection.

## Existing tools

### First-party building blocks

#### `@octokit/auth-app`

[`octokit/auth-app.js`](https://github.com/octokit/auth-app.js) is GitHub's
Octokit authentication library. It mints, caches, and refreshes installation
tokens. It is the strongest foundation for a local broker, but it is a
JavaScript library rather than a machine installer, daemon, Git credential
helper, or `gh` wrapper.

#### `actions/create-github-app-token`

[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
is GitHub's maintained Action for minting installation tokens in Actions jobs.
It is an excellent reference and the right choice in GitHub Actions, but is not
a general workstation token service.

No GitHub-maintained workstation-wide App credential manager was found.
GitHub CLI accepts injected tokens, and Git accepts credential helpers, but the
refresh/routing layer is left to the caller.

### Maintained third-party options

#### `jdx/fnox`

[`fnox`](https://github.com/jdx/fnox) is a maintained secret manager with a
native
[`github-app` credential-lease backend](https://fnox.jdx.dev/leases/github-app).
It mints one-hour installation tokens, can narrow repositories and permissions,
can source the private key from a configured secret provider, caches leases
until shortly before expiry, and injects the result into a child process:

```text
fnox exec -- gh pr list
```

Configure its output as `GH_TOKEN` (rather than the default `GITHUB_TOKEN`) to
give it highest precedence in `gh`. This is the best maintained, ready-made
option found for the **`gh`/API half** of the machine setup. A `gh` executable
shim can make every agent invocation run through `fnox exec`.

It does not by itself make plain HTTPS Git consume `GITHUB_TOKEN`/`GH_TOKEN`;
Git still needs a credential helper (or a carefully scoped askpass wrapper).
It also configures a specific installation, so multi-owner routing needs
separate profiles/configurations selected from repository context.

#### `AmadeusITGroup/gh-app-auth`

[`gh app-auth`](https://github.com/AmadeusITGroup/gh-app-auth) is a GitHub CLI
extension with:

- a Git credential-helper implementation;
- owner/repository prefix routing across Apps;
- OS keyring storage on macOS, Windows, and Linux, with file fallback;
- automatic Git configuration; and
- on-demand installation-token generation.

Its repository was active as of June 2026. It is the closest turnkey option
found for **HTTPS Git authentication** on a multi-organization machine.

Important qualification: its documented normal `gh` commands configure and
test the extension and its Git helper. The README does not document a
machine-wide dynamic `GH_TOKEN` wrapper for arbitrary commands such as
`gh pr create`. Treat it as the Git half of the solution unless that behavior
is independently verified against the desired `gh` commands.

#### `bdellegrazie/git-credential-github-app`

[`git-credential-github-app`](https://github.com/bdellegrazie/git-credential-github-app)
is a focused Go Git credential helper. It can generate Git configuration,
supports explicit installation/organization configuration, and documents SSH
to HTTPS rewriting. Its repository was active as of July 2026.

It solves Git HTTPS credentials, not arbitrary GitHub API client
authentication or commit identity. Its documented setup can also include
Git's credential cache; any cache configuration should be tested carefully
around the one-hour installation-token expiry rather than assuming a cached
token remains usable.

#### `Link-/gh-token`

[`Link-/gh-token`](https://github.com/Link-/gh-token) is a standalone binary
and `gh` extension (`gh token`) that generates, lists, and revokes installation
tokens. It accepts the App ID, installation ID, and PEM/base64 private key and
can print only the token for shell composition.

It is useful as the minting command inside a wrapper, but it is not a broker:
its documentation does not provide automatic renewal, per-repository routing,
Git credential-helper installation, secret storage, or transparent
`GH_TOKEN` injection into arbitrary `gh` commands. Its README currently shows
version 2.0.2, while the repository's visible examples date from 2023; prefer
`fnox` for managed leases or a maintained credential helper for new
machine-wide setups.

### Bare token generators are not enough

Small CLIs such as
[`jhagestedt/ghapp`](https://github.com/jhagestedt/ghapp) and
[`vishu42/github-token`](https://github.com/vishu42/github-token) can mint a
token, but their repositories showed no activity since 2023 at research time,
and token generation alone does not install dynamic routing for both Git and
`gh`. They are weaker choices for a machine-wide control plane.

## Recommended architecture

For the stated goal—silo all AI-originated GitHub activity under one App—the
best boundary is a **dedicated OS account, VM, container, or agent execution
environment**, rather than changing a human's shared global Git configuration.

Within that boundary:

1. Install the App only on the repositories the AI may access.
2. Grant the minimum permissions. Typical write workflows need:
   - `Contents: write` for pushes;
   - `Pull requests: write` for PR creation/updates;
   - additional permissions only for the API operations actually used.
3. Store the App private key in an OS keyring or secret manager. Prefer a
   sign-only vault-backed implementation if building a broker.
4. Use only HTTPS GitHub remotes. Add narrowly scoped SSH-to-HTTPS rewrites if
   tools generate SSH URLs.
5. Install `gh-app-auth` or `git-credential-github-app` as the Git credential
   helper, or expose the broker directly through Git's credential-helper
   protocol.
6. Use a `fnox` GitHub App lease for `gh`, with a wrapper/shim named `gh`
   earlier in the AI account's `PATH`. For a single installation this can run
   the real CLI through `fnox exec`; for multiple installations it must first
   infer the repository and select the matching fnox profile/configuration.
7. Configure the AI environment's Git author and committer to the App bot:
   `<slug>[bot]` and
   `<bot-id>+<slug>[bot]@users.noreply.github.com`.
8. Add a preflight that fails closed before writes:
   - remote is HTTPS and in an allowed owner/repository;
   - selected installation includes that repository;
   - required permission is present;
   - local Git author/committer is the bot;
   - no personal `GH_TOKEN`, stored `gh` account, SSH key, or earlier
     credential helper can win precedence.
9. Log the App slug, installation ID, repository, operation, and resulting URL,
   but never log JWTs, installation tokens, or private-key material.

For Windows, wrappers must cover both PowerShell and processes launched
directly by GUI/agent applications; a PowerShell function alone does not
intercept a child process that resolves `gh.exe` directly. A real executable
shim on `PATH` plus global Git credential-helper configuration is more
reliable.

## What “everything” cannot guarantee

This setup covers tools that:

- invoke HTTPS Git and honor Git credential helpers; or
- use the wrapped `gh`/explicitly accept the installation bearer token.

It does not automatically cover:

- SSH Git;
- applications that use their own credential store;
- API clients that ignore `GH_TOKEN`;
- GitHub endpoints that reject installation tokens;
- repositories outside the selected App installation; or
- commits authored before the bot identity was configured.

Those should fail closed or receive an explicit integration. Keeping personal
credentials and SSH keys out of the dedicated AI environment is what turns
accidental fallback into a visible failure instead of silently attributing
activity to the human user.
