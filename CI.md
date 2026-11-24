# CI: run what the change reaches

Part of the setup formula every MaudeCode repository follows: [REPOSITORIES.md](REPOSITORIES.md).

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
4. **Concurrency.** No pull request run waits for another run. A pull request's first attempt gets a group of its own,
   and its `supersede` job cancels that pull request's older, unfinished runs of the workflow through the Actions API
   without waiting for them to stop. A `concurrency` group with `cancel-in-progress` would hold the new run in
   `pending` until the old one stopped, and a cancelled `xcodebuild` job takes minutes to stop. `supersede` needs
   `actions: write`, is `continue-on-error` because a fork's token cannot cancel, and stays out of `CI Gate`'s `needs`.
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
  # A push to main queues behind the one before it. Every other run stands alone: a pull request's first attempt
  # cancels the runs it replaces in `supersede`, and never waits for them to stop.
  group: >-
    ci-${{ github.event_name == 'push' && github.run_attempt == '1' && github.ref
    || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
  cancel-in-progress: false

jobs:
  supersede:
    name: Supersede
    if: github.event_name == 'pull_request' && github.run_attempt == 1
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    continue-on-error: true # a fork's token cannot cancel
    permissions:
      actions: write
    steps:
      - name: Cancel this pull request's older runs
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          RUN_ID: ${{ github.run_id }}
          BRANCH: ${{ github.head_ref }}
          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}
        run: |
          workflow="$(gh api "repos/$REPO/actions/runs/$RUN_ID" --jq .workflow_id)"
          gh api --paginate "repos/$REPO/actions/workflows/$workflow/runs?event=pull_request&branch=$BRANCH&per_page=100" \
            --jq ".workflow_runs[] | select(.id < $RUN_ID and .status != \"completed\"
              and .head_repository.full_name == \"$HEAD_REPO\") | .id" |
            while read -r id; do
              gh api -X POST "repos/$REPO/actions/runs/$id/cancel" >/dev/null && echo "Cancelled run $id"
            done

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

## Test checks

Two commands hold a repository's tests to the test-audit defect rules. Run both in the CI job of the suite that owns the
tests: `rules` before the tests, `test-durations` on the reports they wrote.

### `maudecode-ci rules --config <path> [--update]`

A pattern scan with a baseline that only goes down. The same command checks test rules and UI rules; each set has its
own config and baseline. Paths on the command line are relative to the working directory.

```json
{
  "extends": "@maudecode/ci/rules/test-rules.base.json",
  "root": "..",
  "roots": ["web/src", "tests"],
  "filePattern": "\\.(?:test\\.ts|py)$",
  "excludeFilePattern": "/node_modules/",
  "baseline": "ci/test-rules-baseline.json",
  "rules": {
    "local-helper": {
      "paths": ["web/src/"],
      "patterns": ["\\bwaitForIdle\\("],
      "message": "test-audit ready: wait on the row, not the helper (docs/testing.md)"
    }
  }
}
```

- `root` is relative to the config, and `roots` and `baseline` to the root. A file is scanned when its path from the
  root matches `filePattern` and not `excludeFilePattern`.
- A rule counts every match of each of its `patterns` in files whose path starts with one of its `paths` (`""` is every
  file), except those under `excludePaths` or matching its own `excludeFilePattern`. `nearby` (`lines` and `pattern`)
  counts a line only when the pattern is within that many lines of it. `blankPattern` blanks the blocks it matches
  before the scan, so their contents never count and line numbers stay those of the file. `ignoreValues` skips a match
  whose first capture group is listed.
- A rule with `"multiline": true` matches each pattern against the whole file, so a call split across lines still
  counts, on the line it starts; `^` and `$` then match at each line. Without it, each line is matched on its own.
- `extends` names one parent config, by a path relative to this one (`./base.json`) or a package path. The parent's
  rules load first, and a local rule with the same id replaces it; nothing else is inherited.
- [`rules/test-rules.base.json`](rules/test-rules.base.json) holds the rules every repository's tests follow:
  `clock-sleep`, `clock-elapsed`, `unheld-clock`, `retry` and `retry-config`, with patterns for Swift, TypeScript and
  Python. They are multiline, so `test.describe.configure({` with `retries: 2` on the next line still counts. Their
  messages point at the repository's own `docs/testing.md`, which says what to do instead. Rules that name one
  repository's helpers stay in that repository's config.

The baseline holds the instances the tree already has, as `counts` per rule and file, and hand-written `exceptions`:

```json
{
  "counts": { "clock-sleep": { "tests/test_poll.py": 2 } },
  "exceptions": [{ "rule": "retry", "file": "tests/test_net.py", "count": 1, "reason": "DOTGH-9: the proxy drops one connection by design" }]
}
```

The check fails a file with more instances than its count plus its exceptions, listing each one with its line, rule and
message. It also fails a count above the tree, so a fixed instance lowers the baseline in the same change: run
`--update`, which lowers counts to the tree and never raises one. A new instance is fixed, or gets an `exceptions` entry
whose `reason` names a ticket or says why it stays; an entry without a reason fails the check.

### `maudecode-ci test-durations --config <path> REPORT...`

A per-test run-time budget. It reads JUnit XML (vitest, Playwright, pytest), `xcrun xcresulttool get test-results tests`
JSON (`*.json`) and XCTest logs (`swift test` output, `*.log`), and fails every test over the budget that the config
does not list:

```json
{
  "budgetSeconds": 30,
  "overBudget": { "session.spec.ts::history loads every page": "DOTGH-9: 34 s on main; split per page" }
}
```

- `budgetSeconds` is 30 when the config leaves it out.
- An `overBudget` key is `suite::test`: a JUnit `classname` or an XCTest suite, then the test's name. It matches a
  JUnit case whose name ends with the title after its describe blocks (`outer > title`), and every parameter of a
  parametrized pytest case (`test_x[a]`). Its value names the ticket that brings the test under the budget; an empty
  one fails the check.
- No report, or reports with no test cases, fail: a run that measured nothing proved nothing.
