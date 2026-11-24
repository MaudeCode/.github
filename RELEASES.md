# Releases: tag last

Part of the setup formula every MaudeCode repository follows: [REPOSITORIES.md](REPOSITORIES.md).

A version tag means the release shipped. A release is started by dispatching the repository's release workflow on its
default branch; the workflow publishes, and its last job creates the `vX.Y.Z` tag. A release that fails leaves no tag,
so the same version is released again once the cause is fixed.

Every MaudeCode repository that publishes versions releases this way. A new repository adopts it from the start:
copy the workflow below, name its CI's gate job in `checks` ([CI.md](CI.md) sets up that CI), and release its first
version through it.

## The contract

`.github/workflows/release.yml`:

1. **Starts by dispatch only.** `on: workflow_dispatch` with two string inputs, and no `push: tags` trigger:
   - `tag` (required): the version, `vX.Y.Z` with an optional prerelease such as `v1.2.0-rc.1`.
   - `sha` (optional): the full SHA of the commit to release: any commit on the default branch after the last
     release. Left empty, the release is of the default branch's head when the run started. The run stays on that
     commit whatever is merged afterwards. Jobs read the commit from preflight's `sha` output, never from the input
     or `github.sha`, which is the branch's head.
2. **Names its run after the version:** `run-name: Release ${{ inputs.tag }}`. Tools find a version's run by this title.
3. **Checks before anything else.** Its first job runs `release-preflight`, and every other job needs it. It refuses a
   run that is not a dispatch on the default branch, a malformed or existing tag, a version that does not come after
   every existing `vX.Y.Z` tag, and a `sha` that is not on the default branch after the last release. It also refuses a
   `sha` whose workflow files differ from the default branch's: GitHub does not let a workflow's token tag such a
   commit, so release a newer one.
4. **Verifies by reuse or by running, and waits on nothing else.** The release names the checks it needs in
   preflight's `checks` input, one `workflow.yml: Job name` a line. A job name ending in `*` names a suite: every
   job whose name starts with what comes before it, such as `ci.yml: web / *`, which is how a repository on
   [CI.md](CI.md) names a suite; there, `ci.yml: CI Gate` names the gate job. A check whose job, or every job of its
   suite, already succeeded in that workflow's push run on the commit is reused; preflight's `verified` output is
   `true` when all of them did, `checks` says which, and `runs` links to the run each was read from. The release runs the others itself, in its own jobs. It never waits for another workflow's run
   to finish, and a failure in a job the release does not name does not hold it up. Pull request CI is not changed for
   a release's sake.
5. **Uses no credential of its own.** Every ref and tag is written with the workflow's `github.token`. A release
   workflow adds no token, deploy key or App for tagging.
6. **Holds workflow changes while it runs.** GitHub refuses a workflow's own token when it tags a commit whose workflow
   files differ from the default branch's, so a workflow change that merges during a release leaves it published and
   untagged. The `release-freeze` action prevents that with a commit status of the same name. A job right after
   preflight runs it with `mode: start`, which fails that status on every open pull request that changes a workflow
   file, and every publishing job needs that job: a release that could not set the freeze publishes nothing. A last
   job with `if: always()` runs `mode: end`, which passes the status again however the release ended. A small workflow
   of its own, on `pull_request_target`, runs `mode: pull-request` for every pull request, so one opened or pushed
   mid-release is caught and every pull request carries the status. It is `pull_request_target` because a fork's or
   Dependabot's `pull_request` run gets a read-only token and could not post a status; it checks out nothing, so it
   never runs the pull request's code. List `release-freeze` as a required status check on the default branch.
7. **Publishes steps that can run again.** Re-running failed jobs, or dispatching the same version again from the same
   commit, must not fail on what an earlier attempt already published.
8. **Tags last.** One final job, needing every publishing job, runs `release-tag` and then creates the GitHub release.
   Nothing else creates the tag.

```yaml
name: Release
run-name: Release ${{ inputs.tag }}

on:
  workflow_dispatch:
    inputs:
      tag: { description: "Version to release, such as v1.2.3", required: true, type: string }
      sha: { description: "Full SHA of the commit to release; empty for the head of main", required: false, type: string }

permissions:
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  preflight:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read # to look up checks that already passed
    outputs:
      version: ${{ steps.check.outputs.version }}
      sha: ${{ steps.check.outputs.sha }}
      prerelease: ${{ steps.check.outputs.prerelease }}
      verified: ${{ steps.check.outputs.verified }}
    steps:
      - id: check
        uses: MaudeCode/.github/actions/release-preflight@<full commit SHA>
        with:
          tag: ${{ inputs.tag }}
          sha: ${{ inputs.sha }}
          checks: |
            ci.yml: Checks

  freeze:
    needs: preflight
    runs-on: ubuntu-24.04
    permissions: { statuses: write, pull-requests: read, actions: read }
    steps:
      - uses: MaudeCode/.github/actions/release-freeze@<full commit SHA>
        with: { mode: start }

  # Runs only when CI has not already passed on this commit.
  verify:
    needs: preflight
    if: needs.preflight.outputs.verified != 'true'
    uses: ./.github/workflows/ci.yml
    with:
      sha: ${{ needs.preflight.outputs.sha }}

  publish:
    needs: [preflight, freeze, verify]
    # A skipped verify is a pass; a failed one stops the release.
    if: ${{ !failure() && !cancelled() }}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.preflight.outputs.sha }}
      # Build and publish version ${{ needs.preflight.outputs.version }}.

  release:
    needs: [preflight, publish]
    if: ${{ !failure() && !cancelled() }}
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - uses: MaudeCode/.github/actions/release-tag@<full commit SHA>
        with:
          tag: ${{ inputs.tag }}
          sha: ${{ needs.preflight.outputs.sha }}
      - env:
          GH_TOKEN: ${{ github.token }}
          PRERELEASE: ${{ needs.preflight.outputs.prerelease }}
        run: |
          gh release create "${{ inputs.tag }}" --repo "$GITHUB_REPOSITORY" --verify-tag --generate-notes \
            $([[ "$PRERELEASE" == true ]] && echo --prerelease)
```

The release's last job:

```yaml
  # In release.yml: after everything else, whatever happened.
  thaw:
    needs: [freeze, release]
    if: always()
    runs-on: ubuntu-24.04
    permissions: { statuses: write, pull-requests: read, actions: read }
    steps:
      - uses: MaudeCode/.github/actions/release-freeze@<full commit SHA>
        with: { mode: end }
```

And `.github/workflows/release-freeze.yml`, for pull requests:

```yaml
name: Release freeze

# pull_request_target, so pull requests from forks and Dependabot get the status too. Safe because nothing is checked
# out: the action reads the pull request's file list through the API and never runs its code. Keep it that way.
on:
  pull_request_target:
    types: [opened, reopened, synchronize]

permissions: {}

jobs:
  status:
    runs-on: ubuntu-24.04
    permissions: { statuses: write, pull-requests: read, actions: read }
    steps:
      - uses: MaudeCode/.github/actions/release-freeze@<full commit SHA>
        with: { mode: pull-request }
```

A release workflow not named `release.yml` passes its file name as `workflow` to all three.

Pin every action to a full commit SHA of this repository.

## Starting a release

The GitHub Scheduler's Releases page, API and MCP tools recognise the contract from the workflow file. They dispatch
the workflow with the next version and the commit shown on the page, follow the run titled `Release <tag>`, and offer the
same version again after a failure. From a terminal:

```sh
gh workflow run release.yml --repo OWNER/REPO --ref main -f tag=v1.2.3
```

## When a release fails

- **Before anything published** (a failing test or build): fix it, then release the same version from the new commit.
- **A flaky step:** re-run the failed jobs of the same run.
- **The tag step is refused (HTTP 403):** a workflow file changed on the default branch while the release ran, which
  `release-freeze` exists to prevent (a direct push, or a merge made over a failing status, still can).
  Everything has published; the step prints the `git tag` and `git push` commands to finish it by hand.
- **After something published under that version from a commit that has since changed:** registries do not take a
  version twice, so release the next version.

## The actions

- `actions/release-preflight`: inputs `tag`, `sha`, optional `checks`; outputs `tag`, `version` (without the `v`),
  `sha`, `prerelease` (`true` for a version such as `v1.2.0-rc.1`; pass it on, since GitHub does not infer a prerelease
  from the tag), `verified`, `checks` and `runs`. Looking up checks needs `actions: read`.
- `actions/release-tag`: inputs `tag`, `sha`, optional `message`. Needs `contents: write`. Creating the tag again at the
  same commit succeeds; at another commit it fails.

- `actions/release-freeze`: inputs `mode` (`pull-request`, `start` or `end`), optional `workflow` (the release workflow's
  file name, `release.yml` by default); outputs `frozen` and `thawed`, the pull request numbers set each way. Needs
  `statuses: write`, `pull-requests: read` and `actions: read`.

All run on the runner's own Node and depend on nothing else. `node --test` runs their tests.

An iOS app's publishing job signs, numbers and uploads to TestFlight through `ios-signing`, `ios-build-number` and
`ios-publish`; see [IOS.md](IOS.md). Re-running it for the same version and commit uploads nothing twice.
