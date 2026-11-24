# CI: run what the change reaches

A pull request or a push runs only the suites its diff reaches. One `CI Gate` job says whether the selected suites
passed, and is the check branch protection requires. A pre-push hook runs the same selection's fast checks before the
push leaves the machine. Everything uncertain runs everything: a path no rule names, a diff that cannot be read, a
manual run.

Every MaudeCode repository sets up CI this way. A new repository starts with it. An existing one moves to it in the
change that next touches its CI.

## The contract

1. **One suites file.** `.github/ci-suites.json` names the repository's suites and the rules that route paths to them:

   ```json
   {
     "suites": {
       "web": { "prePush": ["pnpm run lint:ts", "pnpm run typecheck"] },
       "cli": {}
     },
     "rules": [
       { "paths": ["**/*.md", "docs/**"], "suites": [] },
       { "paths": ["web/convex/**/*.test.ts"], "suites": ["web"] },
       { "paths": ["protocol/**"], "suites": ["web", "cli"] },
       { "paths": ["web/**"], "suites": ["web"] },
       { "paths": [".github/workflows/ci.yml", ".github/ci-suites.json", "package.json", "pnpm-lock.yaml"], "suites": "*" }
     ]
   }
   ```

   - Rules are read in order, and the first rule with a glob that matches a path decides that path's suites. Later
     rules are not consulted for it, so **put narrow rules before broad ones**: above, `web/README.md` runs no suite,
     because the Markdown rule comes before `web/**`.
   - `"suites": "*"` selects every suite, and `[]` selects none.
   - A path no rule matches selects every suite. So does a path with an empty, `.` or `..` segment.
   - A change selects the union of its paths' suites. A rename or a deletion counts under its old and its new path.
   - Globs are `*`, `**` and literal text, matched with Node's `path.matchesGlob`. `*` and `**` do not match a name
     that starts with `.`, so name such paths literally, as in `.github/**`.
   - A rule naming a suite that is not in `suites`, a rule without `paths`, an unknown key, and a suite named `suites`
     or `base` are errors that fail the router, naming the key.
2. **One workflow, three kinds of job.** `.github/workflows/ci.yml` has a router job that runs `ci-suites`, one job
   per suite or group of suites with an `if` on the router's output for it, and `CI Gate`. A suite's jobs are named
   `<suite> / <what it runs>`, so a release can name them all at once (item 8).
3. **Every change triggers it.** `pull_request`, `push` to the default branch, and `workflow_dispatch`, with no `paths`
   filters: the router decides what runs, and a workflow that does not start cannot report.
   - A pull request runs the suites its diff from the merge base with its base branch reaches.
   - A push to the default branch runs the suites its diff from the last commit this workflow passed on there reaches:
     the head of the newest earlier push run that concluded `success`, among the last 50. A failed or cancelled run is
     no base, so a suite that failed runs again on the next push even when that push does not touch it. With no such
     run, every suite runs.
   - A manual run, a schedule, and any other event run every suite.
4. **Concurrency.** A pull request's first attempt shares a group per pull request and cancels the runs it supersedes.
   A push to the default branch shares one group per ref and cancels nothing. A re-run or a manual run gets a group of
   its own and cancels nothing.
5. **Every job is the same kind of job.** A GitHub-hosted runner unless it must reach a private network, a
   `timeout-minutes`, `actions/checkout` with `persist-credentials: false`, Node from `.node-version`, and a frozen
   `pnpm install` with the store cached. No step prepares or cleans up state for a later run: each run starts clean.
   The router checks out with `fetch-depth: 0` and `filter: blob:none`; it reads commits and trees, never contents.
6. **Everything pinned to a commit.** Every action is pinned to a full commit SHA. The `@maudecode/ci` package is
   pinned to the same commit of this repository as its actions: `"@maudecode/ci": "github:MaudeCode/.github#<full commit SHA>"`
   in `devDependencies`.
7. **Required checks: `CI Gate` and `release-freeze`.** `CI Gate` needs the router and every suite job, runs with
   `if: always()`, and fails, naming the job, when a job that runs a selected suite did not succeed, when a suite job
   that was not required ended anything but `success` or `skipped`, or when any other job it needs, such as the
   router, did not succeed. It also fails when it does not need every job that runs a selected suite.
   `release-freeze` is [RELEASES.md](RELEASES.md)'s, for a repository that releases.
8. **A release names suites, not jobs.** In `release-preflight`'s `checks`, a suite is `ci.yml: <suite> / *`: every
   job whose name starts with `<suite> / `. `ci.yml: CI Gate` names them all: a push compares with the last commit
   CI passed on, so a gate that passed on a push means every suite passes on that commit. See
   [RELEASES.md](RELEASES.md), item 4.
9. **A pre-push hook runs the fast checks.** `.githooks/pre-push` is a copy of this repository's
   [`hooks/pre-push`](hooks/pre-push), and the repository's setup instructions say to run
   `git config core.hooksPath .githooks`. Each suite's `prePush` lists the commands that lint and typecheck it; tests
   stay in CI. The hook selects suites for `origin/<default branch>...HEAD`, runs each selected suite's commands in
   order from the repository root, a command shared by two suites once, and stops at the first failure. Never push
   with `--no-verify`; fix the failure and push again.
10. **Finer routing stays in the repository.** Which tests inside a suite run, such as a test plan for the files a
    change touches, belongs to the repository. It runs `maudecode-ci suites` and builds on its output.

### `ci.yml` to copy

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  # A pull request's first attempt replaces its older runs, a push to main queues behind the one before it, and a
  # re-run or a manual run stands alone.
  group: >-
    ci-${{ github.run_attempt == '1' && (github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number)
    || github.event_name == 'push' && github.ref) || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' && github.run_attempt == '1' }}

jobs:
  changes:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      actions: read # a push compares with the last commit this workflow passed on
    outputs:
      suites: ${{ steps.suites.outputs.suites }}
      web: ${{ steps.suites.outputs.web }}
      cli: ${{ steps.suites.outputs.cli }}
    steps:
      - uses: actions/checkout@<full commit SHA>
        with:
          fetch-depth: 0
          filter: blob:none
          persist-credentials: false
      - id: suites
        uses: MaudeCode/.github/actions/ci-suites@<full commit SHA>

  web:
    name: web / test
    needs: changes
    if: needs.changes.outputs.web == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<full commit SHA>
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<full commit SHA>
      - uses: actions/setup-node@<full commit SHA>
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter web test

  cli:
    name: cli / test
    needs: changes
    if: needs.changes.outputs.cli == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<full commit SHA>
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<full commit SHA>
      - uses: actions/setup-node@<full commit SHA>
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter cli test

  gate:
    name: CI Gate
    needs: [changes, web, cli]
    if: always()
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: MaudeCode/.github/actions/ci-gate@<full commit SHA>
        with:
          needs: ${{ toJSON(needs) }}
          selected: ${{ needs.changes.outputs.suites }}
```

A job that runs several suites runs when any of them is selected, and tells the gate which it runs:

```yaml
  app:
    name: app / test
    needs: changes
    if: needs.changes.outputs.web == 'true' || needs.changes.outputs.api == 'true'
    # ...

  gate:
    # ...
      - uses: MaudeCode/.github/actions/ci-gate@<full commit SHA>
        with:
          needs: ${{ toJSON(needs) }}
          selected: ${{ needs.changes.outputs.suites }}
          jobs: '{"app": ["web", "api"], "cli": ["cli"]}'
```

With `jobs`, a needed job it does not list, such as a lint job that always runs, must succeed. Without it, each suite
runs in a job whose id is the suite's name, and every needed job besides the selected suites' may succeed or be
skipped. Pass `jobs` when the workflow has jobs besides the router and the suites.

## The actions and the command

- `actions/ci-suites`: inputs `config` (`.github/ci-suites.json` by default) and `token`; outputs one `true` or
  `false` per suite, `suites` (the selected names as JSON) and `base` (the commit compared with, empty when every suite
  runs without a diff). Its job summary names, for each selected suite, the first path that selected it and the rule
  that matched. A push needs `actions: read`.
- `actions/ci-gate`: inputs `needs` (`toJSON(needs)`), `selected` (the router's `suites`) and optional `jobs`.
- `maudecode-ci suites --base <ref> [--head HEAD] [--merge-base] [--config <path>] [--explain]` prints one
  `name=true|false` line per suite. `--explain` adds a `# path: rule -> suites` line for each changed path.
- `maudecode-ci pre-push` is the hook: it reads Git's pre-push lines from stdin, skips tags and deletions, and refuses
  a pushed branch that is not the commit checked out, because the checks read the working tree.

The package has no install or build script, so a package manager that blocks dependency scripts installs it as it is.
All of it runs on Node alone. `node --test` runs its tests.
