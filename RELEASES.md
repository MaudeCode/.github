# Releases: tag last

A version tag means the release shipped. A release is started by dispatching the repository's release workflow on its
default branch; the workflow publishes, and its last job creates the `vX.Y.Z` tag. A release that fails leaves no tag,
so the same version is released again once the cause is fixed.

Every MaudeCode repository that publishes versions releases this way. A new repository adopts it from the start.

## The contract

`.github/workflows/release.yml`:

1. **Starts by dispatch only.** `on: workflow_dispatch` with two string inputs, and no `push: tags` trigger:
   - `tag` (required): the version, `vX.Y.Z` with an optional prerelease such as `v1.2.0-rc.1`.
   - `sha` (optional): the full SHA of the commit to release. Left empty, the release is of the default branch's
     head when the run started. Given, the run is refused if the branch has moved past it, so what was looked at is
     what ships. Jobs read the commit from preflight's `sha` output, never from the input.
2. **Names its run after the version:** `run-name: Release ${{ inputs.tag }}`. Tools find a version's run by this title.
3. **Checks before anything else.** Its first job runs `release-preflight`, and every other job needs it. It refuses a
   run that is not a dispatch on the default branch, a `sha` that is not the run's commit, a malformed or existing tag,
   and a version that does not come after every existing `vX.Y.Z` tag.
4. **Publishes steps that can run again.** Re-running failed jobs, or dispatching the same version again from the same
   commit, must not fail on what an earlier attempt already published.
5. **Tags last.** One final job, needing every publishing job, runs `release-tag` and then creates the GitHub release.
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
    outputs:
      version: ${{ steps.check.outputs.version }}
      sha: ${{ steps.check.outputs.sha }}
      prerelease: ${{ steps.check.outputs.prerelease }}
    steps:
      - id: check
        uses: MaudeCode/.github/actions/release-preflight@<full commit SHA>
        with:
          tag: ${{ inputs.tag }}
          sha: ${{ inputs.sha }}

  publish:
    needs: preflight
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.preflight.outputs.sha }}
      # Build and publish version ${{ needs.preflight.outputs.version }}.

  release:
    needs: [preflight, publish]
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

Pin both actions to a full commit SHA of this repository.

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
- **After something published under that version from a commit that has since changed:** registries do not take a
  version twice, so release the next version.

## The actions

- `actions/release-preflight`: inputs `tag`, `sha`; outputs `tag`, `version` (without the `v`), `sha` and `prerelease`
  (`true` for a version such as `v1.2.0-rc.1`; pass it on, since GitHub does not infer a prerelease from the tag).
- `actions/release-tag`: inputs `tag`, `sha`, optional `message`. Needs `contents: write`. Creating the tag again at the
  same commit succeeds; at another commit it fails.

Both run on the runner's own Node and depend on nothing else. `node --test` runs their tests.

An iOS app's publishing job signs, numbers and uploads to TestFlight through `ios-signing`, `ios-build-number` and
`ios-publish`; see [IOS.md](IOS.md). Re-running it for the same version and commit uploads nothing twice.
