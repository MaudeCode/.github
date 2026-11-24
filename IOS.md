# iOS: sign, number and publish

Part of the setup formula every MaudeCode repository follows: [REPOSITORIES.md](REPOSITORIES.md).

Every MaudeCode iOS app signs, picks its build number and publishes to TestFlight through three actions in this
repository. An app's workflow keeps only what is really its own: producing an `.xcarchive`. Everything before and after
the archive is the same for every app.

```text
ios-build-number ──► ios-signing ──► (the app's own archive step) ──► ios-publish
```

Pin each action to a full commit SHA of this repository, as for the release actions in [RELEASES.md](RELEASES.md).

## Secrets

Organisation secrets, visible to the app repositories only:

| Secret | Used by |
|---|---|
| `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64` | `ios-signing` |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | `ios-signing` |
| `APP_STORE_CONNECT_KEY_ID` | all three |
| `APP_STORE_CONNECT_ISSUER_ID` | all three |
| `APP_STORE_CONNECT_PRIVATE_KEY` | all three |

The team identifier is read from the certificate, so no secret holds it. A repository or environment secret with the
same name overrides the organisation's; delete such copies once an app has moved to these actions. Keep the publishing
job in a `testflight` environment limited to the release branch as its deployment gate.

## `actions/ios-build-number`

The build number for a version, from App Store Connect: one more than the highest build number App Store Connect holds
for that version, counting uploads that are still processing. The same version and commit asked again gets the number
it already uploaded, so a re-run, or the same version dispatched again from the same commit, does not upload twice.

**How a build is tied to its commit.** `ios-publish` names the uploaded IPA after the commit (`<commit SHA>.ipa`), and
App Store Connect keeps that name on the upload. `ios-build-number` looks for an upload of the version with that name
and returns its number. This keeps numbers increasing within a version whatever order commits are released in, which
a number derived from the commit (such as its time) does not when an older commit ships after a newer one in the same
version. A failed upload's number is not reused. Builds of one commit that differ, such as a Nightly and a production
build that stamp different identities into the app, pass different `variant`s to both actions (the IPA is then named
`<commit SHA>-<variant>.ipa`), so neither takes the other's upload for its own.

It also fails before the archive when App Store Connect would refuse the upload anyway: when an App Store version at
or above this version has been approved, the version's TestFlight train is closed.

Run `ios-build-number` and `ios-publish` in one job, or in jobs that share a `concurrency` group, so two releases
cannot pick the same number.

| Input | |
|---|---|
| `bundle-id` | The app's bundle identifier. |
| `version` | The marketing version, such as `1.2.3`. |
| `commit` | The full SHA of the commit being built. Empty for the checked-out `HEAD`. |
| `variant` | Optional. Keeps apart builds of one commit that differ; lowercase letters, digits and hyphens. Give `ios-publish` the same. |
| `app-store-connect-key-id`, `app-store-connect-issuer-id`, `app-store-connect-private-key` | The App Store Connect API key. |

| Output | |
|---|---|
| `build-number` | The build number to archive with. |
| `uploaded` | `true` when this commit already uploaded this version under that number. |
| `commit` | The full commit SHA the number belongs to; pass it to `ios-publish`. |

## `actions/ios-signing`

Sets up signing for this job:

1. creates a keychain owned by the job, imports the certificate and Apple's intermediate certificates from the selected
   Xcode, and puts it first on the search list;
2. fails unless it can sign as Apple Distribution, by signing a scratch file with the imported identity;
3. reads the team identifier from the certificate;
4. downloads the active App Store profiles for each bundle identifier from App Store Connect and keeps, for each, the
   one that can sign this build: right bundle identifier, right team, includes the imported certificate, not expired. A
   bundle identifier can have several App Store profiles, one per certificate; when none fits, it fails naming the
   bundle identifier, the certificate's serial number and what is wrong with each profile;
5. installs those profiles, and writes the App Store Connect key file and an `ExportOptions.plist`
   (`app-store-connect`, manual signing, the profile per bundle identifier).

Its `post` step runs after the job whether it passed or failed, and deletes the keychain, the installed profiles, the
key file and the export options.

| Input | |
|---|---|
| `certificate-p12-base64` | The Apple Distribution certificate and its private key, a `.p12` in base64. |
| `certificate-password` | The `.p12`'s password. |
| `app-store-connect-key-id`, `app-store-connect-issuer-id`, `app-store-connect-private-key` | The App Store Connect API key. |
| `bundle-ids` | The app's bundle identifier and each extension's, one per line or separated by commas. |
| `internal-testing-only` | `true` makes the build available to internal TestFlight testers only. Default `false`. |

| Output | |
|---|---|
| `team-id` | The team identifier, from the certificate. |
| `profiles` | JSON object from each bundle identifier to its profile's name: `fromJSON(steps.signing.outputs.profiles)['<bundle id>']`. |
| `export-options` | Path of the `ExportOptions.plist` for `ios-publish`. |
| `api-key-path` | Path of the App Store Connect key file, `AuthKey_<key id>.p8`. |
| `keychain` | Path of the job's signing keychain. |

## `actions/ios-publish`

Exports the archive to an IPA and verifies it: the app has the bundle identifier, every extension's identifier sits
under it, the app and every extension carry the version and build number, each embeds an App Store profile for itself
that has not expired, and `codesign --verify --deep --strict` passes.

When `upload` is `true` it then uploads the IPA to TestFlight through the App Store Connect API, waits until Apple has
processed it, and confirms the build is listed as valid. A build App Store Connect already holds for this version and
build number is success and nothing is uploaded again; an earlier attempt's upload that never finished sending is
resumed. Leave `upload` off to prove signing on a pull request or a dry run without publishing.

| Input | |
|---|---|
| `archive` | Path of the `.xcarchive` to export. Give this or `ipa`. |
| `ipa` | Path of an IPA exported earlier, to verify and upload instead, such as one a build job handed to a publishing job. |
| `export-options` | The `export-options` output of `ios-signing`. Needed with `archive`. |
| `bundle-id` | The app's bundle identifier. |
| `version` | The marketing version the IPA must carry. |
| `build-number` | The build number the IPA must carry. |
| `commit` | The `commit` output of `ios-build-number`. Needed with `upload`. |
| `variant` | The `variant` given to `ios-build-number`, if any. |
| `upload` | `true` uploads to TestFlight. Default `false`. |
| `whats-new` | Optional en-US "What to Test" text for the build. |
| `app-store-connect-key-id`, `app-store-connect-issuer-id`, `app-store-connect-private-key` | The App Store Connect API key. Needed with `upload`. |

| Output | |
|---|---|
| `ipa` | Path of the verified IPA. |
| `dsyms` | Path of the archive's dSYMs folder; empty when given an IPA. |
| `build-id` | The App Store Connect build's identifier after an upload. |

## One caller per build style

Each example is the publishing job of a tag-last release (see [RELEASES.md](RELEASES.md)), checked out at the
preflight's commit. Replace `<sha>` with a full commit SHA of this repository.

### Xcode project

```yaml
publish-ios:
  needs: preflight
  runs-on: xcode-27
  environment: testflight
  concurrency: { group: testflight, cancel-in-progress: false }
  steps:
    - uses: actions/checkout@<sha>
      with: { ref: "${{ needs.preflight.outputs.sha }}", persist-credentials: false }
    - id: number
      uses: MaudeCode/.github/actions/ios-build-number@<sha>
      with:
        bundle-id: dev.example.app
        version: ${{ needs.preflight.outputs.version }}
        app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
        app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
        app-store-connect-private-key: ${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
    - id: signing
      uses: MaudeCode/.github/actions/ios-signing@<sha>
      with:
        certificate-p12-base64: ${{ secrets.IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64 }}
        certificate-password: ${{ secrets.IOS_DISTRIBUTION_CERTIFICATE_PASSWORD }}
        app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
        app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
        app-store-connect-private-key: ${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
        bundle-ids: dev.example.app, dev.example.app.share
    - env:
        TEAM: ${{ steps.signing.outputs.team-id }}
        APP_PROFILE: ${{ fromJSON(steps.signing.outputs.profiles)['dev.example.app'] }}
        SHARE_PROFILE: ${{ fromJSON(steps.signing.outputs.profiles)['dev.example.app.share'] }}
        VERSION: ${{ needs.preflight.outputs.version }}
        BUILD: ${{ steps.number.outputs.build-number }}
      run: |
        xcodebuild archive -project App.xcodeproj -scheme App -configuration Release \
          -destination generic/platform=iOS -archivePath "$RUNNER_TEMP/App.xcarchive" \
          DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
          APP_PROFILE_SPECIFIER="$APP_PROFILE" SHARE_PROFILE_SPECIFIER="$SHARE_PROFILE" \
          MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD"
    - id: publish
      uses: MaudeCode/.github/actions/ios-publish@<sha>
      with:
        archive: ${{ runner.temp }}/App.xcarchive
        export-options: ${{ steps.signing.outputs.export-options }}
        bundle-id: dev.example.app
        version: ${{ needs.preflight.outputs.version }}
        build-number: ${{ steps.number.outputs.build-number }}
        commit: ${{ steps.number.outputs.commit }}
        upload: true
        app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
        app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
        app-store-connect-private-key: ${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
```

The project's targets read their profile from a build setting per target (here `APP_PROFILE_SPECIFIER` and
`SHARE_PROFILE_SPECIFIER`), so each target gets its own profile.

### XcodeGen

The same job; generate the project before archiving it.

```yaml
    - run: xcodegen generate
      working-directory: ios
    - env:
        TEAM: ${{ steps.signing.outputs.team-id }}
        PROFILE: ${{ fromJSON(steps.signing.outputs.profiles)['dev.example.app'] }}
        VERSION: ${{ needs.preflight.outputs.version }}
        BUILD: ${{ steps.number.outputs.build-number }}
      working-directory: ios
      run: |
        xcodebuild archive -project App.xcodeproj -scheme App -configuration Release \
          -destination generic/platform=iOS -archivePath "$RUNNER_TEMP/App.xcarchive" \
          DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
          PROVISIONING_PROFILE_SPECIFIER="$PROFILE" \
          MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD"
```

### Expo prebuild

The same job; generate the native project, then set manual signing on the app target only, since the Pods targets
must not receive the app's profile. The app's config reads the version and build number from the environment.

```yaml
    - env:
        APP_VERSION: ${{ needs.preflight.outputs.version }}
        APP_BUILD_NUMBER: ${{ steps.number.outputs.build-number }}
      run: |
        pnpm exec expo prebuild --platform ios --no-install
        (cd ios && pod install)
    - env:
        TEAM: ${{ steps.signing.outputs.team-id }}
        PROFILE: ${{ fromJSON(steps.signing.outputs.profiles)['dev.example.app'] }}
      run: |
        node scripts/set-app-target-signing.js   # CODE_SIGN_STYLE, DEVELOPMENT_TEAM, PROVISIONING_PROFILE_SPECIFIER
        xcodebuild archive -workspace ios/App.xcworkspace -scheme App -configuration Release \
          -destination generic/platform=iOS -archivePath "$RUNNER_TEMP/App.xcarchive"
```

## Tests

`node --test` runs the tests. Everything that touches a keychain, a profile, an IPA or Apple goes through one runner
object (`system` in `lib/ios.js`) that the tests replace, so they need neither a Mac nor secrets.
