"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, verify, X509Certificate } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const ios = require("../lib/ios.js");

// A self-signed stand-in for an Apple Distribution certificate, valid until 2126.
const PEM = `-----BEGIN CERTIFICATE-----
MIICKjCCAdCgAwIBAgIUOR4efeOTF2A+XS37JBUInDd0/dYwCgYIKoZIzj0EAwIw
ejEXMBUGCgmSJomT8ixkAQEMB1RFU1RVSUQxLjAsBgNVBAMMJUFwcGxlIERpc3Ry
aWJ1dGlvbjogVGVzdCAoVEVBTTEyMzRBQikxEzARBgNVBAsMClRFQU0xMjM0QUIx
DTALBgNVBAoMBFRlc3QxCzAJBgNVBAYTAlVTMCAXDTI2MTExNzEyMjkwNFoYDzIx
MjYxMDI0MTIyOTA0WjB6MRcwFQYKCZImiZPyLGQBAQwHVEVTVFVJRDEuMCwGA1UE
AwwlQXBwbGUgRGlzdHJpYnV0aW9uOiBUZXN0IChURUFNMTIzNEFCKTETMBEGA1UE
CwwKVEVBTTEyMzRBQjENMAsGA1UECgwEVGVzdDELMAkGA1UEBhMCVVMwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATu/nreApZIpuhkFwTK9VYE1Kj2iBglfY2Uvkvx
EefKmrGCaL+pKWirlJCFIs3njCOhImjZjAWSh/Ahyjc6X0p6ozIwMDAdBgNVHQ4E
FgQUJoDz45En2jVdmdQMX+YDZT0q57UwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjO
PQQDAgNIADBFAiAaQUHaubUb8ReKmZlJLFFqdwcmjKp/IbLwIJpBO1OJfgIhAJU8
hysYujF807cK+HYwbqfjxqz3R7FBSTTFUS9mw9Fm
-----END CERTIFICATE-----`;
const CERTIFICATE = new X509Certificate(PEM).raw;
const HASH = "00789EAB85C1DB5377DB7DCF1F97A89CE5013DE5";
const TEAM = "TEAM1234AB";
const APP = "dev.example.app";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "ios-test-"));

/** A decoded provisioning profile as `security cms -D` prints it. */
function profileXml({ name = "App Store", team = TEAM, prefix = team, appId = `${prefix}.${APP}`, expires = "2027-06-01T00:00:00Z", certificates = [CERTIFICATE], uuid = "UUID-1", extra = "" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>${name}</string>
  <key>UUID</key><string>${uuid}</string>
  <key>TeamIdentifier</key><array><string>${team}</string></array>
  <key>ApplicationIdentifierPrefix</key><array><string>${prefix}</string></array>
  <key>ExpirationDate</key><date>${expires}</date>
  <key>DeveloperCertificates</key><array>${certificates.map((der) => `<data>\n${der.toString("base64")}\n</data>`).join("")}</array>
  <key>Entitlements</key><dict><key>application-identifier</key><string>${appId}</string>${extra}</dict>
</dict></plist>`;
}

/** The runner's tools: plutil and security cms read the file they are given as XML; anything else answers from `answers`. */
function runner(answers = {}) {
  const calls = [];
  return {
    calls,
    now: () => NOW,
    sleep: async () => {},
    async fetch(url, init) {
      calls.push(`${init.method} ${url} ${init.body.length}`);
      return { ok: true, status: 200 };
    },
    exec(command, args) {
      calls.push([command, ...args].join(" "));
      const answer = answers[`${command} ${args[0]}`];
      if (answer) return typeof answer === "function" ? answer(args) : answer;
      if (command === "plutil" || (command === "security" && args[0] === "cms")) return fs.readFileSync(args.at(-1), "utf8");
      return "";
    },
  };
}

/** App Store Connect behind `api(method, location, body)`, keeping what it was sent. */
function appleApi(routes) {
  const writes = [];
  const api = async (method, location, body) => {
    const url = new URL(location, "https://api.appstoreconnect.apple.com");
    if (method !== "GET") writes.push(`${method} ${url.pathname}`);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${url.pathname}`);
    const data = route(Object.fromEntries(url.searchParams), body?.data);
    return { data };
  };
  return { api, writes };
}

test("a property list reads back what the export options wrote", () => {
  const xml = ios.exportOptions({ team: TEAM, profiles: [{ bundleId: APP, name: "App & Store" }, { bundleId: `${APP}.share`, name: "Share" }] });
  assert.deepEqual(ios.parsePlist(xml), {
    method: "app-store-connect", destination: "export", signingStyle: "manual", signingCertificate: "Apple Distribution", teamID: TEAM,
    provisioningProfiles: { [APP]: "App & Store", [`${APP}.share`]: "Share" },
    manageAppVersionAndBuildNumber: false, stripSwiftSymbols: true, uploadSymbols: true,
  });
  assert.equal(ios.parsePlist(ios.exportOptions({ team: TEAM, profiles: [], internalTestingOnly: true })).testFlightInternalTestingOnly, true);
});

test("a profile signs only its own bundle identifier, for the team, with this certificate, before it expires", () => {
  const check = (options) => ios.profileProblem(ios.parsePlist(profileXml(options)), { bundleId: APP, team: TEAM, certificate: CERTIFICATE, now: NOW });
  assert.equal(check(), null);
  assert.equal(check({ prefix: "LEGACY1234" }), null, "an App ID prefix other than the team");
  assert.match(check({ appId: `${TEAM}.dev.example.other` }), /is for TEAM1234AB\.dev\.example\.other, not TEAM1234AB\.dev\.example\.app/);
  assert.match(check({ team: "OTHERTEAM1", appId: `OTHERTEAM1.${APP}` }), /belongs to team OTHERTEAM1, not TEAM1234AB/);
  assert.match(check({ expires: "2026-11-01T00:00:00Z" }), /expired on 2026-11-01/);
  assert.match(check({ certificates: [Buffer.from("another certificate")] }), /does not include the distribution certificate/);
});

/** App Store Connect's bundle identifiers and their profiles, keyed by bundle identifier. */
function profileRoutes(profiles) {
  return {
    "GET /v1/bundleIds": ({ "filter[identifier]": id }) => [{ id: `bundle:${id}`, attributes: { identifier: id } }, { id: "near", attributes: { identifier: `${id}.near` } }],
    "GET /v1/bundleIds/bundle:dev.example.app/profiles": () => profiles.map((options, i) => ({
      id: `profile-${i}`,
      attributes: { profileType: options.type ?? "IOS_APP_STORE", profileState: options.state ?? "ACTIVE", profileContent: Buffer.from(profileXml(options)).toString("base64") },
    })),
  };
}

const keychainAnswers = {
  "security find-identity": `  1) ${HASH} "Apple Distribution: Test (TEAM1234AB)"\n     1 identities found\n`,
  "security find-certificate": `${PEM}\n`,
  "security list-keychains": (args) => (args.includes("-s") ? "" : '    "/Users/runner/Library/Keychains/login.keychain-db"\n'),
  "xcode-select -p": "/nonexistent/Xcode.app/Contents/Developer\n",
};

test("signing sets up a job keychain, installs the checked profile, writes the key and export options, and post removes them", async () => {
  const [temp, home] = [temporary(), temporary()];
  const state = {};
  const run = runner(keychainAnswers);
  const { api } = appleApi(profileRoutes([{ appId: `${TEAM}.dev.example.other`, uuid: "WRONG" }, { name: "App Store", uuid: "UUID-1" }]));
  const outputs = await ios.setUpSigning(
    { p12: Buffer.from("p12").toString("base64"), password: "secret", keyId: "KEY123", issuerId: "issuer", privateKey: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----", bundleIds: [APP] },
    { run, api, temp, home, save: (name, value) => { state[name] = value; } },
  );
  assert.equal(outputs["team-id"], TEAM);
  assert.deepEqual(JSON.parse(outputs.profiles), { [APP]: "App Store" });
  assert.equal(outputs.keychain, state.keychain);
  assert.equal(ios.parsePlist(fs.readFileSync(outputs["export-options"], "utf8")).provisioningProfiles[APP], "App Store");
  assert.equal(fs.readFileSync(outputs["api-key-path"], "utf8"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
  assert.equal(fs.statSync(outputs["api-key-path"]).mode & 0o777, 0o600);
  const installed = JSON.parse(state.profiles);
  assert.equal(installed.length, 2);
  assert.ok(installed.every((file) => file.startsWith(home) && file.endsWith("UUID-1.mobileprovision") && fs.existsSync(file)));
  assert.ok(run.calls.includes(`security list-keychains -d user -s ${state.keychain} /Users/runner/Library/Keychains/login.keychain-db`));
  assert.ok(run.calls.some((call) => call.startsWith(`codesign --force --sign ${HASH} --keychain ${state.keychain}`)), "it proves it can sign");
  assert.ok(!fs.existsSync(path.join(state.directory, "distribution.p12")), "the .p12 does not outlive its import");

  const post = runner();
  ios.cleanup(state, { run: post });
  assert.deepEqual(post.calls, [`security delete-keychain ${state.keychain}`]);
  assert.ok(!fs.existsSync(state.directory) && installed.every((file) => !fs.existsSync(file)));
});

test("signing fails without an Apple Distribution identity or a usable profile, and post still removes what it made", async () => {
  const setUp = (answers, profiles) => {
    const state = {};
    const signing = ios.setUpSigning(
      { p12: "cDEy", password: "secret", keyId: "KEY123", issuerId: "issuer", privateKey: "key", bundleIds: [APP] },
      { run: runner({ ...keychainAnswers, ...answers }), api: appleApi(profileRoutes(profiles)).api, temp: temporary(), home: temporary(), save: (name, value) => { state[name] = value; } },
    );
    return { signing, state };
  };
  const unsigned = setUp({ "security find-identity": "     0 identities found\n" }, []);
  await assert.rejects(unsigned.signing, /did not import an Apple Distribution identity/);
  const post = runner();
  ios.cleanup(unsigned.state, { run: post });
  assert.deepEqual(post.calls, [`security delete-keychain ${unsigned.state.keychain}`]);
  assert.ok(!fs.existsSync(unsigned.state.directory));

  const expired = setUp({}, [{ expires: "2026-01-01T00:00:00Z" }, { type: "IOS_APP_DEVELOPMENT" }]);
  await assert.rejects(expired.signing, /No usable App Store profile for dev\.example\.app with certificate 391E1E7DE393176\w+\. Profile "App Store" expired/);
  // Two App Store profiles for the bundle identifier, each for another certificate: the one for this certificate signs.
  const two = setUp({}, [{ name: "Other certificate", certificates: [Buffer.from("another certificate")] }, { name: "This certificate" }]);
  assert.deepEqual(JSON.parse((await two.signing).profiles), { [APP]: "This certificate" });
  await assert.rejects(setUp({}, [{ name: "Other certificate", certificates: [Buffer.from("another certificate")] }]).signing,
    /No usable App Store profile for dev\.example\.app with certificate 391E1E7DE393176\w+\. Profile "Other certificate" does not include the distribution certificate/);
  await assert.rejects(setUp({}, []).signing, /has no active App Store profile/);
});

/** App Store Connect for one app, its TestFlight builds and the uploads behind them. */
function testflight({ builds = [], uploads = [], files = {}, versions = [], processing = 1, outcome = "VALID" } = {}) {
  const store = { builds, uploads, files, versions, localizations: [], polls: 0 };
  const matches = (row, query) => (!query["filter[cfBundleShortVersionString]"] || row.attributes.cfBundleShortVersionString === query["filter[cfBundleShortVersionString]"])
    && (!query["filter[cfBundleVersion]"] || row.attributes.cfBundleVersion === query["filter[cfBundleVersion]"]);
  const { api, writes } = appleApi({
    "GET /v1/apps": () => [{ id: "app", attributes: { bundleId: APP } }],
    "GET /v1/apps/app/appStoreVersions": () => store.versions.map(([versionString, appStoreState]) => ({ attributes: { versionString, appStoreState } })),
    "GET /v1/apps/app/buildUploads": (query) => store.uploads.filter((row) => matches(row, query)),
    "GET /v1/builds": (query) => store.builds.filter((row) => row.marketing === query["filter[preReleaseVersion.version]"]
      && (row.platform ?? "IOS") === (query["filter[preReleaseVersion.platform]"] ?? row.platform ?? "IOS")
      && (!query["filter[version]"] || row.attributes.version === query["filter[version]"])),
    "POST /v1/buildUploads": (_, data) => {
      const upload = { id: `upload-${store.uploads.length}`, attributes: { ...data.attributes, state: { state: "AWAITING_UPLOAD" } } };
      store.uploads.push(upload);
      return upload;
    },
    "POST /v1/buildUploadFiles": (_, data) => {
      const size = data.attributes.fileSize;
      const file = { id: "file", attributes: { ...data.attributes, assetDeliveryState: { state: "AWAITING_UPLOAD" }, uploadOperations: [
        { method: "PUT", url: "https://upload.example/b", offset: 4, length: size - 4 }, { method: "PUT", url: "https://upload.example/a", offset: 0, length: 4 },
      ] } };
      store.files[data.relationships.buildUpload.data.id] = [file];
      return file;
    },
    "PATCH /v1/buildUploadFiles/file": () => {
      const [upload] = store.uploads.filter((row) => store.files[row.id]?.[0].id === "file");
      store.files[upload.id][0].attributes.assetDeliveryState.state = "COMPLETE";
      upload.attributes.state.state = "PROCESSING";
      store.builds.push({ id: "build-new", marketing: upload.attributes.cfBundleShortVersionString, attributes: { version: upload.attributes.cfBundleVersion, processingState: "PROCESSING", expired: false, usesNonExemptEncryption: false } });
      return {};
    },
    "GET /v1/buildUploads/upload-0": () => {
      if (++store.polls > processing) {
        store.uploads[0].attributes.state.state = "COMPLETE";
        for (const build of store.builds) build.attributes.processingState = outcome;
      }
      return store.uploads[0];
    },
    "GET /v1/builds/build-new/betaBuildLocalizations": () => store.localizations,
    "POST /v1/betaBuildLocalizations": (_, data) => { store.localizations.push({ id: "en", attributes: data.attributes }); return {}; },
    "PATCH /v1/betaBuildLocalizations/en": (_, data) => { Object.assign(store.localizations[0].attributes, data.attributes); return {}; },
  });
  for (const upload of uploads) store.files[upload.id] ??= [];
  // Each upload's files, at /v1/buildUploads/<id>/buildUploadFiles.
  const withFiles = async (method, location, body) => {
    const match = /^\/v1\/buildUploads\/([^/?]+)\/buildUploadFiles/.exec(location);
    return match ? { data: store.files[match[1]] ?? [] } : api(method, location, body);
  };
  return { api: withFiles, writes, store };
}

const upload = (id, version, number, state = "COMPLETE") => ({ id, attributes: { cfBundleShortVersionString: version, cfBundleVersion: number, platform: "IOS", state: { state } } });
const build = (version, number) => ({ id: `build-${number}`, marketing: version, attributes: { version: number, processingState: "VALID", expired: false, usesNonExemptEncryption: false } });

test("the build number follows the highest App Store Connect holds for the version, and a commit gets its own upload's number again", async () => {
  const ask = (apple, version = "1.2.0", commit = COMMIT) => ios.buildNumber(apple.api, { bundleId: APP, version, commit });
  assert.deepEqual(await ask(testflight()), { number: "1", uploaded: false });
  assert.deepEqual(await ask(testflight({ builds: [build("1.2.0", "7"), build("1.2.0", "12"), build("1.1.0", "40")], uploads: [upload("u", "1.2.0", "13", "PROCESSING")] })), { number: "14", uploaded: false });
  assert.deepEqual(await ask(testflight({ builds: [build("1.2.0", "1.9")] })), { number: "1.10", uploaded: false });

  const earlier = testflight({ builds: [build("1.2.0", "5"), build("1.2.0", "6")], uploads: [upload("mine", "1.2.0", "5"), upload("theirs", "1.2.0", "6")],
    files: { mine: [{ attributes: { fileName: `${COMMIT}.ipa` } }], theirs: [{ attributes: { fileName: `${OTHER}.ipa` } }] } });
  assert.deepEqual(await ask(earlier), { number: "5", uploaded: true }, "a re-run gets the number this commit uploaded");
  assert.deepEqual(await ask(earlier, "1.2.0", "e".repeat(40)), { number: "7", uploaded: false });
  // The same commit built as another variant is another build.
  assert.deepEqual(await ios.buildNumber(earlier.api, { bundleId: APP, version: "1.2.0", commit: COMMIT, variant: "nightly" }), { number: "7", uploaded: false });
  const nightly = testflight({ builds: [build("1.2.0", "5")], uploads: [upload("n", "1.2.0", "5")], files: { n: [{ attributes: { fileName: `${COMMIT}-nightly.ipa` } }] } });
  assert.deepEqual(await ios.buildNumber(nightly.api, { bundleId: APP, version: "1.2.0", commit: COMMIT, variant: "nightly" }), { number: "5", uploaded: true });
  assert.deepEqual(await ask(nightly), { number: "6", uploaded: false }, "a production build does not take the Nightly's upload");
  await assert.rejects(ios.buildNumber(nightly.api, { bundleId: APP, version: "1.2.0", commit: COMMIT, variant: "Night ly" }), /not a variant/);
  const failed = testflight({ uploads: [upload("mine", "1.2.0", "5", "FAILED")], files: { mine: [{ attributes: { fileName: `${COMMIT}.ipa` } }] } });
  assert.deepEqual(await ask(failed), { number: "6", uploaded: false }, "a failed upload's number is not reused");

  await assert.rejects(ask(testflight({ versions: [["1.2.0", "READY_FOR_SALE"]] })), /1\.2\.0 TestFlight train is closed: App Store version 1\.2\.0 is approved/);
  assert.deepEqual(await ask(testflight({ versions: [["1.1.0", "READY_FOR_SALE"], ["1.3.0", "PREPARE_FOR_SUBMISSION"]] })), { number: "1", uploaded: false });
  await assert.rejects(ask(testflight({ builds: [build("1.2.0", "7a")] })), /non-numeric build numbers 7a/);
  await assert.rejects(ios.buildNumber(testflight().api, { bundleId: APP, version: "1.2.0", commit: "abc" }), /not a full commit SHA/);
  await assert.rejects(ios.buildNumber(testflight().api, { bundleId: APP, version: "v1.2.0", commit: COMMIT }), /not a marketing version/);
});

/** An IPA as `unzip` lays it out: each bundle's Info.plist and embedded profile, written as XML. */
function ipaRunner({ bundles, codesign = true }) {
  return runner({
    "unzip -q": (args) => {
      const into = args.at(-1);
      for (const [where, { id, version = "1.2.0", number = "7", encryption = "<false/>", profile = {} }] of Object.entries(bundles)) {
        const bundle = path.join(into, "Payload", where);
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "Info.plist"), `<plist><dict>${encryption ? `<key>ITSAppUsesNonExemptEncryption</key>${encryption}` : ""}<key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${number}</string></dict></plist>`);
        if (profile) fs.writeFileSync(path.join(bundle, "embedded.mobileprovision"), profileXml({ appId: `${profile.prefix ?? TEAM}.${id}`, ...profile }));
      }
      return "";
    },
    "codesign --verify": () => { if (!codesign) throw new Error("codesign --verify failed with exit 1: a sealed resource is missing or invalid"); return ""; },
  });
}

test("an IPA is verified: identifiers, version and build number in every bundle, App Store profiles, and the signature", () => {
  const share = "App.app/PlugIns/Share.appex";
  const check = (bundles, options) => ios.verifyIpa(ipaRunner({ bundles, ...options }), { ipa: "/tmp/App.ipa", bundleId: APP, version: "1.2.0", buildNumber: "7", directory: path.join(temporary(), "ipa") });
  assert.equal(check({ "App.app": { id: APP }, [share]: { id: `${APP}.share`, encryption: "" } }), false);
  assert.equal(check({ "App.app": { id: APP, encryption: "<true/>" } }), true);
  check({ "App.app": { id: APP, profile: { prefix: "LEGACY1234" } } });
  for (const [bundles, options, problem] of [
    [{ "App.app": { id: APP, encryption: "" }, [share]: { id: `${APP}.share` } }, {}, /ITSAppUsesNonExemptEncryption/],
    [{ "App.app": { id: APP, encryption: "<string>NO</string>" } }, {}, /ITSAppUsesNonExemptEncryption/],
    [{ "App.app": { id: "dev.example.wrong" } }, {}, /App\.app has bundle identifier dev\.example\.wrong, expected dev\.example\.app/],
    [{ "App.app": { id: APP }, [share]: { id: "dev.other.share" } }, {}, /Share\.appex has bundle identifier dev\.other\.share/],
    [{ "App.app": { id: APP }, [share]: { id: `${APP}.share`, number: "6" } }, {}, /Share\.appex is 1\.2\.0 \(6\), expected 1\.2\.0 \(7\)/],
    [{ "App.app": { id: APP, version: "1.1.0" } }, {}, /App\.app is 1\.1\.0 \(7\)/],
    [{ "App.app": { id: APP, profile: null } }, {}, /App\.app embeds no provisioning profile/],
    [{ "App.app": { id: APP, profile: { appId: `${TEAM}.${APP}.share` } } }, {}, /embeds profile "App Store" for TEAM1234AB\.dev\.example\.app\.share/],
    [{ "App.app": { id: APP, profile: { extra: "<key>get-task-allow</key><true/>" } } }, {}, /not an App Store profile/],
    [{ "App.app": { id: APP, profile: { expires: "2026-01-01T00:00:00Z" } } }, {}, /has expired/],
    [{ "App.app": { id: APP } }, { codesign: false }, /signature does not verify: .*sealed resource/],
  ]) assert.throws(() => check(bundles, options), problem, problem.source);
});

test("uploading sends the IPA once, waits for Apple, and a run again for the same version and number uploads nothing", async () => {
  const ipa = path.join(temporary(), "App.ipa");
  fs.writeFileSync(ipa, "signed release bytes");
  const send = (apple, run = runner(), whatsNew = "Fixes") => ios.uploadToTestFlight(apple.api, run, { ipa, bundleId: APP, version: "1.2.0", buildNumber: "7", commit: COMMIT, usesNonExemptEncryption: false, whatsNew, attempts: 5, delay: 0 });

  const apple = testflight({ builds: [build("1.1.0", "7")] });
  const run = runner();
  assert.deepEqual(await send(apple, run), { buildId: "build-new", uploaded: true });
  assert.deepEqual(apple.writes, ["POST /v1/buildUploads", "POST /v1/buildUploadFiles", "PATCH /v1/buildUploadFiles/file", "POST /v1/betaBuildLocalizations"]);
  assert.equal(apple.store.files["upload-0"][0].attributes.fileName, `${COMMIT}.ipa`, "the upload names its commit for ios-build-number");
  const variant = testflight();
  await ios.uploadToTestFlight(variant.api, runner(), { ipa, bundleId: APP, version: "1.2.0", buildNumber: "7", commit: COMMIT, variant: "nightly", attempts: 5, delay: 0 });
  assert.equal(variant.store.files["upload-0"][0].attributes.fileName, `${COMMIT}-nightly.ipa`);
  assert.deepEqual(run.calls, ["PUT https://upload.example/a 4", "PUT https://upload.example/b 16"]);
  assert.deepEqual(apple.store.localizations.map((row) => row.attributes), [{ locale: "en-US", whatsNew: "Fixes" }]);
  assert.deepEqual(await ios.buildNumber(apple.api, { bundleId: APP, version: "1.2.0", commit: COMMIT }), { number: "7", uploaded: true });

  apple.writes.length = 0;
  const again = runner();
  assert.deepEqual(await send(apple, again, "Fixes, again"), { buildId: "build-new", uploaded: false });
  assert.deepEqual(apple.writes, ["PATCH /v1/betaBuildLocalizations/en"], "nothing is uploaded twice");
  assert.deepEqual(again.calls, []);
  assert.deepEqual(apple.store.localizations.map((row) => row.attributes), [{ locale: "en-US", whatsNew: "Fixes, again" }]);

  // The same version and number on another platform is not this build.
  const mac = testflight({ builds: [{ ...build("1.2.0", "7"), platform: "MAC_OS" }] });
  assert.deepEqual(await send(mac, runner(), ""), { buildId: "build-new", uploaded: true });

  // A build another tool uploaded, with no upload record behind it, counts the same.
  const elsewhere = testflight({ builds: [build("1.2.0", "7")] });
  assert.deepEqual(await send(elsewhere, runner(), ""), { buildId: "build-7", uploaded: false });
  assert.deepEqual(elsewhere.writes, []);
  const processed = build("1.2.0", "7");
  for (const value of [null, true]) {
    processed.attributes.usesNonExemptEncryption = value;
    await assert.rejects(send(testflight({ builds: [processed] })), /encryption declaration/);
  }
});

test("an upload an earlier attempt left unsent is resumed with the same IPA and refused with another", async () => {
  const ipa = path.join(temporary(), "App.ipa");
  fs.writeFileSync(ipa, "signed release bytes");
  const send = (apple, attempts = 5) => ios.uploadToTestFlight(apple.api, runner(), { ipa, bundleId: APP, version: "1.2.0", buildNumber: "7", commit: COMMIT, attempts, delay: 0 });
  const reserved = (size) => testflight({ uploads: [upload("upload-0", "1.2.0", "7", "AWAITING_UPLOAD")], files: { "upload-0": [{ id: "file", attributes: {
    fileName: `${COMMIT}.ipa`, fileSize: size, assetDeliveryState: { state: "AWAITING_UPLOAD" }, uploadOperations: [{ method: "PUT", url: "https://upload.example/a", offset: 0, length: size }],
  } }] } });

  const resumed = reserved(20);
  assert.deepEqual(await send(resumed), { buildId: "build-new", uploaded: true });
  assert.deepEqual(resumed.writes, ["PATCH /v1/buildUploadFiles/file"]);
  await assert.rejects(send(reserved(99)), /reserved 1\.2\.0 \(7\) for a different IPA/);
  await assert.rejects(send(testflight({ outcome: "INVALID" })), /Apple processed 1\.2\.0 \(7\) as INVALID/);
  await assert.rejects(send(testflight({ processing: 10 }), 3), /still processing 1\.2\.0 \(7\)\. Run this job again/);
});

test("the App Store Connect token is an ES256 JWT for the key, and other origins never see it", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const seen = [];
  const run = { now: () => NOW, fetch: async (url, init) => { seen.push([String(url), init.headers.authorization]); return new Response('{"data":[]}'); } };
  const api = ios.appStoreConnect({ keyId: "KEY123", issuerId: "issuer", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n"), run });
  await api("GET", "/v1/apps");
  const [header, payload, signature] = seen[0][1].slice("Bearer ".length).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "KEY123", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "issuer");
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.ok(claims.exp - NOW / 1000 <= 20 * 60);
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  await assert.rejects(api("GET", "https://example.com/v1/apps"), /Refusing App Store Connect credentials for https:\/\/example\.com/);
  assert.equal(seen.length, 1);
});

test("the post step removes what the main step recorded, from the runner's saved state, even with no keychain made", () => {
  const directory = temporary();
  const profile = path.join(temporary(), "UUID-1.mobileprovision");
  fs.writeFileSync(path.join(directory, "AuthKey_KEY123.p8"), "key");
  fs.writeFileSync(profile, "profile");
  const post = spawnSync(process.execPath, [path.join(__dirname, "../actions/ios-signing/post.js")], {
    env: { PATH: "/nonexistent", STATE_directory: directory, STATE_keychain: path.join(directory, "signing.keychain-db"), STATE_profiles: JSON.stringify([profile]) },
    encoding: "utf8",
  });
  assert.equal(post.status, 0, post.stdout + post.stderr);
  assert.ok(!fs.existsSync(directory) && !fs.existsSync(profile));
});
