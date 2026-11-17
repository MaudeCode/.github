"use strict";
// What every iOS app's release shares around its own archive step (IOS.md): signing, the build number and publishing to
// TestFlight. No dependencies. Everything that touches a keychain, a profile, an IPA or Apple goes through `system`, so
// the tests replace it and run without a Mac or secrets.

const { spawnSync } = require("node:child_process");
const { createPrivateKey, randomBytes, sign: signData, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The runner's tools. Tests pass their own. */
const system = {
  /** Run a command; its stdout, or an error naming the command and the end of its output. */
  exec(command, args, { input, stream = false } = {}) {
    const result = spawnSync(command, args, { input, encoding: "utf8", maxBuffer: 256 << 20, stdio: stream ? ["ignore", "inherit", "inherit"] : "pipe" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-5).join(" ");
      throw new Error(`${command} ${args[0]} failed with exit ${result.status}${output ? `: ${output}` : ""}`);
    }
    return result.stdout ?? "";
  },
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

// --- Property lists -------------------------------------------------------------------------------------------------

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (text) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name) =>
  name[0] === "#" ? String.fromCodePoint(Number(name[1].toLowerCase() === "x" ? `0${name.slice(1)}` : name.slice(1))) : ENTITIES[name]);
const escape = (text) => String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

/** An XML property list as plain values: `<data>` becomes a Buffer and `<date>` a Date. */
function parsePlist(xml) {
  const tokens = xml.replace(/<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "").match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  // Whitespace between elements is layout; inside <string> it is content, which `text` keeps.
  const next = () => {
    while (i < tokens.length && !tokens[i].trim()) i++;
    return tokens[i++];
  };
  const text = (tag) => {
    let value = "";
    while (i < tokens.length && tokens[i] !== `</${tag}>`) value += tokens[i++];
    i++;
    return unescape(value);
  };
  function value(token = next()) {
    const [, tag, empty] = /^<([a-z]+)[^>]*?(\/?)>$/.exec(token ?? "") ?? [];
    if (empty) return { string: "", data: Buffer.alloc(0), dict: {}, array: [], true: true, false: false }[tag];
    switch (tag) {
      case "plist": { const inner = value(); next(); return inner; }
      case "dict": {
        const dict = {};
        for (let key = next(); key !== "</dict>"; key = next()) {
          if (key !== "<key>") throw new Error(`Not a property list: expected <key>, found ${key}`);
          const name = text("key");
          dict[name] = value();
        }
        return dict;
      }
      case "array": {
        const array = [];
        for (let item = next(); item !== "</array>"; item = next()) array.push(value(item));
        return array;
      }
      case "string": return text(tag);
      case "integer": case "real": return Number(text(tag));
      case "data": return Buffer.from(text(tag).replace(/\s+/g, ""), "base64");
      case "date": return new Date(text(tag));
      default: throw new Error(`Not a property list: unexpected ${token}`);
    }
  }
  return value();
}

/** A property list of strings, booleans and dictionaries. */
function writePlist(value) {
  const write = (item, indent) => {
    if (typeof item === "boolean") return `${indent}<${item}/>`;
    if (typeof item === "string") return `${indent}<string>${escape(item)}</string>`;
    const entries = Object.entries(item).map(([key, inner]) => `${indent}\t<key>${escape(key)}</key>\n${write(inner, `${indent}\t`)}`);
    return `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${write(value, "")}\n</plist>\n`;
}

/** A property list file in any format, through plutil. */
const readPlist = (run, file) => parsePlist(run.exec("plutil", ["-convert", "xml1", "-o", "-", file]));
/** A signed provisioning profile's contents, through security cms. */
const readProfile = (run, file) => parsePlist(run.exec("security", ["cms", "-D", "-i", file]));

// --- App Store Connect ----------------------------------------------------------------------------------------------

const ORIGIN = "https://api.appstoreconnect.apple.com";

/** The private key as PEM, whether the secret holds real newlines or literal `\n`. */
const privateKeyPem = (key) => key.trim().replace(/\\n/g, "\n");

/**
 * App Store Connect's API with a team key. `api(method, path, body)` returns the parsed body or throws with Apple's
 * error; it refuses any other origin, so the key's token never leaves Apple.
 */
function appStoreConnect({ keyId, issuerId, privateKey, run = system }) {
  const key = createPrivateKey(privateKeyPem(privateKey));
  let token = null;
  let expires = 0;
  const jwt = () => {
    const now = Math.floor(run.now() / 1000);
    if (token && now < expires - 60) return token;
    expires = now + 19 * 60; // Apple refuses tokens that live longer than 20 minutes.
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ iss: issuerId, iat: now - 30, exp: expires, aud: "appstoreconnect-v1" })}`;
    token = `${input}.${signData("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    return token;
  };
  return async function api(method, location, body) {
    const url = new URL(location, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error(`Refusing App Store Connect credentials for ${url.origin}.`);
    const response = await run.fetch(url, {
      method,
      headers: { authorization: `Bearer ${jwt()}`, accept: "application/json", ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const errors = (data?.errors ?? []).map((error) => error.detail ?? error.title).join(" ");
      throw new Error(`App Store Connect ${method} ${url.pathname} failed: HTTP ${response.status} ${errors}`.trim());
    }
    return data;
  };
}

/** Every row of a listing, across pages. */
async function list(api, location, params = {}) {
  const rows = [];
  for (let next = `${location}?${new URLSearchParams({ limit: "200", ...params })}`; next; ) {
    const page = await api("GET", next);
    rows.push(...page.data);
    next = page.links?.next;
  }
  return rows;
}

/** The App Store Connect app for a bundle identifier. */
async function appId(api, bundleId) {
  const apps = (await list(api, "/v1/apps", { "filter[bundleId]": bundleId, "fields[apps]": "bundleId" }))
    .filter((app) => app.attributes.bundleId === bundleId);
  if (apps.length !== 1) throw new Error(`Expected one App Store Connect app for ${bundleId}, found ${apps.length}.`);
  return apps[0].id;
}

// --- Signing --------------------------------------------------------------------------------------------------------

/** The identity's certificate (DER) and team: the team is the certificate subject's organisational unit. */
function distributionCertificate(run, keychain) {
  const identities = run.exec("security", ["find-identity", "-p", "codesigning", keychain]);
  const hash = /^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Distribution: [^"]+"/m.exec(identities)?.[1];
  if (!hash) throw new Error("The certificate did not import an Apple Distribution identity.");
  const pems = run.exec("security", ["find-certificate", "-a", "-p", keychain]).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const certificate = pems.map((pem) => new X509Certificate(pem)).find((cert) => cert.fingerprint.replace(/:/g, "") === hash);
  const team = certificate && /^OU=(.+)$/m.exec(certificate.subject)?.[1];
  if (!team) throw new Error("The Apple Distribution certificate names no team.");
  if (new Date(certificate.validTo).getTime() <= run.now()) throw new Error(`The Apple Distribution certificate expired on ${certificate.validTo}.`);
  return { hash, team, der: certificate.raw, serial: certificate.serialNumber };
}

/** Why a decoded profile cannot sign `bundleId` for `team` with `certificate`, or null when it can. */
function profileProblem(profile, { bundleId, team, certificate, now }) {
  const name = `Profile "${profile.Name}"`;
  if (!(profile.TeamIdentifier ?? []).includes(team)) return `${name} belongs to team ${(profile.TeamIdentifier ?? []).join(", ")}, not ${team}.`;
  // The App ID prefix is usually the team, but an older App ID can carry a prefix of its own.
  const appId = profile.Entitlements?.["application-identifier"];
  const prefixes = profile.ApplicationIdentifierPrefix ?? [team];
  if (!prefixes.some((prefix) => appId === `${prefix}.${bundleId}`)) return `${name} is for ${appId}, not ${prefixes[0]}.${bundleId}.`;
  if (!(profile.ExpirationDate?.getTime() > now)) return `${name} expired on ${profile.ExpirationDate?.toISOString()}.`;
  if (!(profile.DeveloperCertificates ?? []).some((der) => der.equals(certificate))) return `${name} does not include the distribution certificate.`;
  return null;
}

/**
 * The App Store profile for each bundle identifier that can sign with this certificate, decoded and checked. A bundle
 * identifier can have several App Store profiles, each for another certificate, so the first one is not enough.
 */
async function appStoreProfiles(api, run, { bundleIds, team, certificate, serial, directory }) {
  const chosen = [];
  for (const bundleId of bundleIds) {
    const ids = (await list(api, "/v1/bundleIds", { "filter[identifier]": bundleId })).filter((row) => row.attributes.identifier === bundleId);
    if (ids.length !== 1) throw new Error(`Expected one App Store Connect bundle identifier ${bundleId}, found ${ids.length}.`);
    // A relationship listing takes at most 50 rows a page.
    const candidates = (await list(api, `/v1/bundleIds/${ids[0].id}/profiles`, { limit: "50" }))
      .filter((row) => row.attributes.profileType === "IOS_APP_STORE" && row.attributes.profileState === "ACTIVE");
    const problems = [];
    const usable = [];
    for (const row of candidates) {
      const file = path.join(directory, `${row.id}.mobileprovision`);
      fs.writeFileSync(file, Buffer.from(row.attributes.profileContent, "base64"));
      const profile = readProfile(run, file);
      const problem = profileProblem(profile, { bundleId, team, certificate, now: run.now() });
      if (problem) problems.push(problem);
      else usable.push({ bundleId, name: profile.Name, uuid: profile.UUID, expires: profile.ExpirationDate, file });
    }
    if (!usable.length) {
      throw new Error(`No usable App Store profile for ${bundleId} with certificate ${serial}. ${problems.join(" ") || "App Store Connect has no active App Store profile for it."}`);
    }
    chosen.push(usable.sort((a, b) => b.expires - a.expires)[0]);
  }
  return chosen;
}

/** The ExportOptions.plist for an App Store Connect export with these profiles. */
function exportOptions({ team, profiles, internalTestingOnly = false }) {
  return writePlist({
    method: "app-store-connect",
    destination: "export",
    signingStyle: "manual",
    signingCertificate: "Apple Distribution",
    teamID: team,
    provisioningProfiles: Object.fromEntries(profiles.map((profile) => [profile.bundleId, profile.name])),
    manageAppVersionAndBuildNumber: false,
    stripSwiftSymbols: true,
    uploadSymbols: true,
    ...(internalTestingOnly && { testFlightInternalTestingOnly: true }),
  });
}

/** Where Xcode looks for installed profiles. */
const profileDirectories = (home) => [
  path.join(home, "Library/MobileDevice/Provisioning Profiles"),
  path.join(home, "Library/Developer/Xcode/UserData/Provisioning Profiles"),
];

/**
 * Set up signing for one job: a keychain of its own holding the distribution identity, the checked App Store profiles
 * installed, the App Store Connect key file and the export options. `save(name, value)` records each thing before it is
 * created, so `cleanup` removes it even when a later step fails.
 */
async function setUpSigning({ p12, password, keyId, issuerId, privateKey, bundleIds, internalTestingOnly }, { run = system, api, temp, home, save }) {
  if (!bundleIds.length) throw new Error("ios-signing needs at least one bundle identifier.");
  const directory = fs.mkdtempSync(path.join(temp, "ios-signing-"));
  save("directory", directory);
  const keychain = path.join(directory, "signing.keychain-db");
  const keychainPassword = randomBytes(32).toString("hex");
  const certificateFile = path.join(directory, "distribution.p12");
  fs.writeFileSync(certificateFile, Buffer.from(p12, "base64"), { mode: 0o600 });
  save("keychain", keychain);
  run.exec("security", ["create-keychain", "-p", keychainPassword, keychain]);
  run.exec("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  run.exec("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
  try {
    run.exec("security", ["import", certificateFile, "-k", keychain, "-f", "pkcs12", "-P", password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
  } finally {
    fs.rmSync(certificateFile, { force: true });
  }
  // Apple's intermediates ship with the selected Xcode; codesign needs the chain in a searched keychain.
  const resources = path.join(run.exec("xcode-select", ["-p"]).trim(), "../SharedFrameworks/DVTFoundation.framework/Versions/A/Resources");
  for (const name of fs.existsSync(resources) ? fs.readdirSync(resources).filter((file) => /^AppleWWDRCA.*\.cer$/.test(file)) : []) {
    try { run.exec("security", ["import", path.join(resources, name), "-k", keychain]); } catch { /* already present */ }
  }
  run.exec("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
  // Search the job's keychain first; the runner's own keychains stay listed.
  const searched = run.exec("security", ["list-keychains", "-d", "user"]).split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  run.exec("security", ["list-keychains", "-d", "user", "-s", keychain, ...searched.filter((item) => item !== keychain)]);

  const certificate = distributionCertificate(run, keychain);
  // Proof that it can sign, without a prompt: sign a scratch file with the identity.
  const probe = path.join(directory, "probe");
  fs.copyFileSync("/usr/bin/true", probe);
  run.exec("codesign", ["--force", "--sign", certificate.hash, "--keychain", keychain, probe]);

  const apple = api ?? appStoreConnect({ keyId, issuerId, privateKey, run });
  const profiles = await appStoreProfiles(apple, run, { bundleIds, team: certificate.team, certificate: certificate.der, serial: certificate.serial, directory });
  const installed = [];
  for (const profile of profiles) {
    for (const target of profileDirectories(home)) {
      fs.mkdirSync(target, { recursive: true });
      const file = path.join(target, `${profile.uuid}.mobileprovision`);
      installed.push(file);
      save("profiles", JSON.stringify(installed));
      fs.copyFileSync(profile.file, file);
    }
  }

  const apiKeyPath = path.join(directory, `AuthKey_${keyId}.p8`);
  fs.writeFileSync(apiKeyPath, `${privateKeyPem(privateKey)}\n`, { mode: 0o600 });
  const exportOptionsPath = path.join(directory, "ExportOptions.plist");
  fs.writeFileSync(exportOptionsPath, exportOptions({ team: certificate.team, profiles, internalTestingOnly }));
  return {
    "team-id": certificate.team,
    profiles: JSON.stringify(Object.fromEntries(profiles.map((profile) => [profile.bundleId, profile.name]))),
    "export-options": exportOptionsPath,
    "api-key-path": apiKeyPath,
    keychain,
  };
}

/** Remove what `setUpSigning` recorded: the keychain, the installed profiles and the directory with the key file. */
function cleanup({ keychain, profiles, directory }, { run = system } = {}) {
  if (keychain) {
    try { run.exec("security", ["delete-keychain", keychain]); } catch { /* never created */ }
  }
  for (const file of profiles ? JSON.parse(profiles) : []) fs.rmSync(file, { force: true });
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

// --- Build numbers --------------------------------------------------------------------------------------------------

const NUMBER = /^\d+(?:\.\d+){0,2}$/;

/** Numeric precedence of dotted numbers such as build numbers and marketing versions. */
function compareNumbers(a, b) {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// App Store states in which Apple has approved a version and closed its TestFlight train: any later upload needs a
// higher marketing version.
const APPROVED = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE"]);

/** An upload's IPA is named after the commit it was built from: that is how a re-run finds its own build. */
const uploadFileName = (commit) => `${commit}.ipa`;

/**
 * The build number for `version` built from `commit`: the number of this commit's earlier upload of that version when
 * there is one, otherwise one more than the highest number App Store Connect holds for the version.
 */
async function buildNumber(api, { bundleId, version, commit }) {
  if (!NUMBER.test(version)) throw new Error(`${JSON.stringify(version)} is not a marketing version such as 1.2.3.`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a full commit SHA.`);
  const app = await appId(api, bundleId);
  const approved = (await list(api, `/v1/apps/${app}/appStoreVersions`, { "filter[platform]": "IOS", "fields[appStoreVersions]": "versionString,appStoreState" }))
    .filter((row) => APPROVED.has(row.attributes.appStoreState) && NUMBER.test(row.attributes.versionString))
    .find((row) => compareNumbers(version, row.attributes.versionString) <= 0);
  if (approved) throw new Error(`The ${version} TestFlight train is closed: App Store version ${approved.attributes.versionString} is approved. Release a version above it.`);

  const uploads = await list(api, `/v1/apps/${app}/buildUploads`, { "filter[cfBundleShortVersionString]": version, "filter[platform]": "IOS" });
  for (const upload of uploads.filter((row) => row.attributes.state?.state !== "FAILED")) {
    const files = await list(api, `/v1/buildUploads/${upload.id}/buildUploadFiles`);
    if (files.some((file) => file.attributes.fileName === uploadFileName(commit))) return { number: upload.attributes.cfBundleVersion, uploaded: true };
  }
  const builds = await list(api, "/v1/builds", { "filter[app]": app, "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": "IOS", "fields[builds]": "version" });
  const numbers = [...builds.map((row) => row.attributes.version), ...uploads.map((row) => row.attributes.cfBundleVersion)];
  const invalid = numbers.filter((number) => !NUMBER.test(number));
  if (invalid.length) throw new Error(`Cannot choose a number after the non-numeric build numbers ${[...new Set(invalid)].join(", ")}.`);
  const highest = numbers.sort(compareNumbers).at(-1);
  if (!highest) return { number: "1", uploaded: false };
  const parts = highest.split(".").map(Number);
  parts[parts.length - 1] += 1;
  return { number: parts.join("."), uploaded: false };
}

// --- Export and verification ----------------------------------------------------------------------------------------

/** Export the archive with the export options and return the IPA's path. */
function exportArchive(run, { archive, exportOptions: options, directory }) {
  if (!options) throw new Error("Exporting an archive needs the export options from ios-signing.");
  run.exec("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", directory, "-exportOptionsPlist", options], { stream: true });
  const ipas = fs.readdirSync(directory).filter((file) => file.endsWith(".ipa"));
  if (ipas.length !== 1) throw new Error(`The export produced ${ipas.length} IPAs, expected one.`);
  return path.join(directory, ipas[0]);
}

/**
 * Check an IPA before it leaves the job: the app and every extension carry the version and build number, the app has
 * the bundle identifier and each extension sits under it, each embeds an App Store profile for itself, and the
 * signature verifies. Throws with every problem found.
 */
function verifyIpa(run, { ipa, bundleId, version, buildNumber: number, directory }) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  run.exec("unzip", ["-q", ipa, "-d", directory]);
  const payload = path.join(directory, "Payload");
  const apps = fs.existsSync(payload) ? fs.readdirSync(payload).filter((name) => name.endsWith(".app")) : [];
  if (apps.length !== 1) throw new Error(`${path.basename(ipa)} holds ${apps.length} apps, expected one.`);
  const app = path.join(payload, apps[0]);
  const extensions = ["PlugIns", "Extensions"].flatMap((folder) => {
    const where = path.join(app, folder);
    return fs.existsSync(where) ? fs.readdirSync(where).filter((name) => name.endsWith(".appex")).map((name) => path.join(where, name)) : [];
  });
  const problems = [];
  for (const bundle of [app, ...extensions]) {
    const name = path.relative(payload, bundle);
    const info = readPlist(run, path.join(bundle, "Info.plist"));
    const id = info.CFBundleIdentifier;
    if (bundle === app ? id !== bundleId : !id?.startsWith(`${bundleId}.`)) problems.push(`${name} has bundle identifier ${id}, expected ${bundle === app ? bundleId : `${bundleId}.*`}.`);
    if (info.CFBundleShortVersionString !== version || info.CFBundleVersion !== number) {
      problems.push(`${name} is ${info.CFBundleShortVersionString} (${info.CFBundleVersion}), expected ${version} (${number}).`);
    }
    const embedded = path.join(bundle, "embedded.mobileprovision");
    if (!fs.existsSync(embedded)) { problems.push(`${name} embeds no provisioning profile.`); continue; }
    const profile = readProfile(run, embedded);
    const prefixes = profile.ApplicationIdentifierPrefix ?? profile.TeamIdentifier ?? [];
    const entitlements = profile.Entitlements ?? {};
    if (!prefixes.some((prefix) => entitlements["application-identifier"] === `${prefix}.${id}`)) {
      problems.push(`${name} embeds profile "${profile.Name}" for ${entitlements["application-identifier"]}, not ${prefixes[0]}.${id}.`);
    }
    if (profile.ProvisionedDevices || profile.ProvisionsAllDevices || entitlements["get-task-allow"]) problems.push(`${name} embeds "${profile.Name}", which is not an App Store profile.`);
    if (!(profile.ExpirationDate?.getTime() > run.now())) problems.push(`${name} embeds "${profile.Name}", which has expired.`);
  }
  try {
    run.exec("codesign", ["--verify", "--deep", "--strict", app]);
  } catch (error) {
    problems.push(`The signature does not verify: ${error.message}`);
  }
  if (problems.length) throw new Error(`${path.basename(ipa)} failed verification. ${problems.join(" ")}`);
}

// --- Upload ---------------------------------------------------------------------------------------------------------

const UPLOAD_STATES = new Set(["AWAITING_UPLOAD", "PROCESSING", "COMPLETE"]);

/** Send the IPA's bytes to the upload operations Apple handed out, which must cover the file exactly once in order. */
async function transfer(run, ipa, operations) {
  const size = fs.statSync(ipa).size;
  let offset = 0;
  const sorted = [...operations].sort((a, b) => a.offset - b.offset);
  for (const operation of sorted) {
    const url = new URL(operation.url);
    if (operation.method !== "PUT" || url.protocol !== "https:" || url.username || operation.offset !== offset || !(operation.length > 0)) {
      throw new Error("App Store Connect handed out an invalid upload operation.");
    }
    offset += operation.length;
  }
  if (offset !== size) throw new Error("App Store Connect's upload operations do not cover the IPA.");
  const bytes = fs.readFileSync(ipa);
  for (const operation of sorted) {
    const response = await run.fetch(operation.url, {
      method: "PUT",
      headers: Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value])),
      body: bytes.subarray(operation.offset, operation.offset + operation.length),
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Uploading part of the IPA failed: HTTP ${response.status}`);
  }
}

/** The en-US "What to Test" text, updated in place when an earlier attempt already wrote it. */
async function setWhatsNew(api, build, text) {
  const existing = (await list(api, `/v1/builds/${build}/betaBuildLocalizations`)).find((row) => row.attributes.locale === "en-US");
  if (existing) {
    await api("PATCH", `/v1/betaBuildLocalizations/${existing.id}`, { data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew: text } } });
  } else {
    await api("POST", "/v1/betaBuildLocalizations", { data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew: text }, relationships: { build: { data: { type: "builds", id: build } } } } });
  }
}

/**
 * Upload the IPA to TestFlight as `version` (`number`), wait until Apple has processed it, and confirm the build is
 * listed. A build App Store Connect already holds for this version and number is success, so running it again uploads
 * nothing; an earlier attempt's upload that never finished is resumed.
 * @returns {Promise<{ buildId: string, uploaded: boolean }>}
 */
async function uploadToTestFlight(api, run, { ipa, bundleId, version, buildNumber: number, commit, whatsNew, attempts = 180, delay = 10_000 }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Uploading needs the full commit SHA from ios-build-number.");
  const app = await appId(api, bundleId);
  const builds = () => list(api, "/v1/builds", { "filter[app]": app, "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": "IOS", "filter[version]": number, "fields[builds]": "version,processingState,expired" });
  let uploaded = false;
  let upload = null;
  if (!(await builds()).length) {
    const uploads = await list(api, `/v1/apps/${app}/buildUploads`, { "filter[cfBundleShortVersionString]": version, "filter[cfBundleVersion]": number, "filter[platform]": "IOS" });
    const live = uploads.filter((row) => row.attributes.state?.state !== "FAILED");
    if (live.length > 1) throw new Error(`App Store Connect holds ${live.length} uploads of ${version} (${number}).`);
    upload = live[0] ?? (await api("POST", "/v1/buildUploads", { data: {
      type: "buildUploads",
      attributes: { platform: "IOS", cfBundleShortVersionString: version, cfBundleVersion: number },
      relationships: { app: { data: { type: "apps", id: app } } },
    } })).data;
    if (!UPLOAD_STATES.has(upload.attributes.state?.state)) throw new Error(`The upload of ${version} (${number}) is ${upload.attributes.state?.state}.`);
    const size = fs.statSync(ipa).size;
    let files = await list(api, `/v1/buildUploads/${upload.id}/buildUploadFiles`);
    if (!files.length && upload.attributes.state.state === "AWAITING_UPLOAD") {
      files = [(await api("POST", "/v1/buildUploadFiles", { data: {
        type: "buildUploadFiles",
        attributes: { fileName: uploadFileName(commit), fileSize: size, assetType: "ASSET", uti: "com.apple.ipa" },
        relationships: { buildUpload: { data: { type: "buildUploads", id: upload.id } } },
      } })).data];
    }
    if (files.length !== 1) throw new Error(`The upload of ${version} (${number}) has ${files.length} files, expected one.`);
    const [file] = files;
    if (file.attributes.assetDeliveryState?.state === "AWAITING_UPLOAD") {
      if (file.attributes.fileSize !== size) {
        throw new Error(`An earlier attempt reserved ${version} (${number}) for a different IPA and never sent it. Release the next version.`);
      }
      await transfer(run, ipa, file.attributes.uploadOperations ?? []);
      await api("PATCH", `/v1/buildUploadFiles/${file.id}`, { data: { type: "buildUploadFiles", id: file.id, attributes: { uploaded: true } } });
      uploaded = true;
    }
  }
  for (let attempt = 1; ; attempt++) {
    if (upload) {
      const state = (await api("GET", `/v1/buildUploads/${upload.id}`)).data.attributes.state?.state;
      if (!UPLOAD_STATES.has(state)) throw new Error(`Apple did not accept ${version} (${number}): the upload is ${state}.`);
    }
    const found = await builds();
    if (found.length > 1) throw new Error(`App Store Connect lists ${found.length} builds of ${version} (${number}).`);
    const build = found[0];
    const processing = build?.attributes.processingState;
    if (build && processing !== "PROCESSING" && processing !== "VALID") throw new Error(`Apple processed ${version} (${number}) as ${processing}.`);
    if (processing === "VALID") {
      if (build.attributes.expired) throw new Error(`TestFlight build ${version} (${number}) has expired.`);
      if (whatsNew) await setWhatsNew(api, build.id, whatsNew);
      return { buildId: build.id, uploaded };
    }
    if (attempt >= attempts) throw new Error(`Apple is still processing ${version} (${number}). Run this job again to keep waiting; it does not upload twice.`);
    await run.sleep(delay);
  }
}

// --- Action plumbing ------------------------------------------------------------------------------------------------

/** An action input, as the runner passes it. */
const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();

/** Hide a secret, and each of its lines, from the log before anything uses it. */
function mask(value) {
  // One line at a time: a workflow command ends at a newline, so a multi-line value would print its later lines.
  for (const line of value.split(/\r?\n|\\n/)) if (line.trim()) console.log(`::add-mask::${line.trim()}`);
}

/** Append `name=value` lines to a runner file such as GITHUB_OUTPUT or GITHUB_STATE. */
const record = (file, values) => fs.appendFileSync(file, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));

module.exports = {
  input, mask, record,
  system, parsePlist, writePlist, appStoreConnect, list, profileProblem, appStoreProfiles, exportOptions, setUpSigning,
  cleanup, compareNumbers, buildNumber, exportArchive, verifyIpa, uploadToTestFlight, uploadFileName,
};
