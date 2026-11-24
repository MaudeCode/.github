# Repositories: the setup formula

Every MaudeCode repository is set up the same way: its agent instructions, its toolchain, its CI, its hooks, its
tests, its releases, its repository settings and its tracker. A new repository is set up by walking this page from top
to bottom, ending with the [checklist](#new-repository-checklist). An existing one is brought in line by comparing it
against the page, one ticket per gap, so each move is reviewed on its own.

This page says what a repository has and why. The details live in the topic contracts it links to:
[CI.md](CI.md), [RELEASES.md](RELEASES.md) and [IOS.md](IOS.md).

## Agent instructions

A root `AGENTS.md` holds the working agreement, so an agent learns how work is done here before it edits anything. A
component with rules of its own, such as an app beside a server, has its own `AGENTS.md`, and the root file says which
one to read for which directory.

Repository files stay scrubbed of hostnames, personal names, local paths and secret values: a repository may be made
public, and its history keeps whatever it ever held. Where infrastructure matters, a file describes the pattern and
points at the workflow or config that holds it.

The root file's working agreement covers nine topics. Copy the block below and adapt it: replace `<KEY>` with the
tracker project's key, list the repository's own scopes and server, and keep the rest. Each paragraph is one rule a
reviewer can check.

```markdown
## Working agreement

**Tracker.** Kanvil project <KEY> is the tracker for every component. Each ticket carries one or more scope labels, in
its native `scopes` and in its labels:
- `<scope>`: what the scope covers, by directory
- `tooling`: CI, release, scripts and agent documentation

**Ticket states.** Work only on the selected ticket and its required dependencies. Move the ticket to In Progress before
editing, to In Review once its verified commits are on its pull request, and to Done only after its commit is verified
on the default branch.

**Branches and subjects.** Branches are `<type>/<KEY>-<number>-<slug>`. Commit and pull request subjects are
Conventional Commits that end with the ticket key, `<type>(<scope>): <summary> (<KEY>-<number>)`, because release
tooling suggests the next version from the type.

**Server-owned state.** Clients are display-only. The server computes every decision, classification, derivation,
ordering, filtering and computed value a client shows, and ships each as an explicit field of the shared contract.
Client logic is limited to wording; number, date and unit formatting; layout, theme, animation and accessibility;
device-local UI state; optimistic display of the user's own writes; offline display of cached fields; and platform
integration. Anything else moves to the server and the contract in the same change.

**Optimistic writes.** A user-initiated write shows its result at once. If the server refuses it, the client rolls back
to the last confirmed value and shows the error. An unknown outcome (network loss, timeout, 5xx) reconciles with the
server before the client keeps or rolls back the change, and a non-idempotent write is never replayed blind. Only
writes whose result the server must produce keep a busy state, and only on the control that started them.

**Tests.** Tests own synthetic, disposable state and never depend on a live account, service or device. Read
`docs/testing.md` before writing, changing or fixing a test. Every added or changed test passes the test-audit
authoring gate, and fixing a bad test writes its rule into the test-audit skill in the same change.

**Dependencies.** Add no third-party dependency without the owner's approval.

**Evidence.** Screenshots and other validation evidence go in the pull request, never in git. Images are committed
only as shipped or tested assets.

**Owner gates.** Releases, deployments, TestFlight uploads, repository administration, archival and changes to live
services wait for the owner.
```

## Toolchain

- **pnpm** is the package manager, pinned with `packageManager` in the root `package.json`. The repository is one pnpm
  workspace with one `pnpm-lock.yaml`, installed with `pnpm install --frozen-lockfile`, so a checkout installs exactly
  what CI installs.
- **Node** is on the latest LTS line, named once in `.node-version` at the repository root. CI reads that file, and a
  version manager that reads it selects the same Node in every checkout and worktree with no setup.
- **Scripts run on Node**, with no second runtime, so one toolchain covers the app, its scripts and CI.
- **TypeScript 7** is the TypeScript major, pinned in the lockfile.
- **Vitest** runs TypeScript tests.
- **oxlint** lints and **oxfmt** formats, and CI checks both.
- **One place per version.** Each toolchain version is pinned in one place: Node in `.node-version`, pnpm in
  `packageManager`, every package in the lockfile. An iOS app pins Xcode in one setup action that every iOS job uses,
  and signs and publishes as [IOS.md](IOS.md) says.

A repository on another package manager or runtime moves to this one in a ticket of its own.

## CI

CI follows [CI.md](CI.md#the-contract):

- `.github/ci-suites.json` names the repository's suites and routes each path to them.
- `.github/workflows/ci.yml` runs a router, then only the suites a change reaches.
- `CI Gate` reports whether the selected suites passed, and is the check the default branch requires.

Every job runs on a GitHub-hosted runner unless it must reach a private network, and carries no state from one run to
the next ([CI.md](CI.md#the-contract), item 5).

## Pre-push hook

`.githooks/pre-push` is the stub from [`hooks/pre-push`](hooks/pre-push), and each suite's `prePush` commands in the
suites file are what it runs ([CI.md](CI.md#the-contract), item 9). The repository's setup instructions name the one
command that turns it on. Never bypass the hook with `--no-verify`; fix what it reports and push again.

## Tests

- Every added or changed test passes the test-audit authoring gate.
- The `rules` and `test-durations` checks run in CI, in the job of the suite that owns the tests
  ([CI.md](CI.md#test-checks)).
- `docs/testing.md` lists the repository's own helper for each test-audit defect rule, which the check messages point
  to.
- Fixing a bad test writes its rule into the test-audit skill in the same change.

## Releases

A repository that publishes versions releases by [RELEASES.md](RELEASES.md#the-contract): a dispatched release workflow
that publishes, then tags last.

## Repository settings

The default branch carries a ruleset with:

- required status checks `CI Gate` and, for a repository that releases, `release-freeze`
  ([CI.md](CI.md#the-contract), item 7);
- signed commits;
- no force push and no deletion.

The owner applies the ruleset. An agent that sets a repository up states these settings in its pull request.

## Tracker

The repository has one Kanvil project, linked to the repository's git remote so the remote names the project. Its
tickets carry the scope labels the root `AGENTS.md` names.

## New repository checklist

1. [Agent instructions](#agent-instructions): a root `AGENTS.md` with the working agreement, and one per component with
   rules of its own.
2. [Toolchain](#toolchain): pnpm with `packageManager` and a frozen lockfile, `.node-version`, TypeScript, Vitest, oxlint
   and oxfmt.
3. [CI](#ci): the suites file, the routed `ci.yml` and `CI Gate`, as [CI.md](CI.md) sets them up.
4. [Pre-push hook](#pre-push-hook): `.githooks/pre-push` and each suite's `prePush` commands.
5. [Tests](#tests): `docs/testing.md` and the `rules` and `test-durations` checks in CI.
6. [Releases](#releases): the release workflow from [RELEASES.md](RELEASES.md), for a repository that publishes.
7. [Repository settings](#repository-settings): the default branch's ruleset, applied by the owner.
8. [Tracker](#tracker): one Kanvil project linked to the repository, with its scope labels.
