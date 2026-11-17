"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { run } = require("../../lib/release.js");
const { appStoreConnect, exportArchive, input, mask, record, system, uploadToTestFlight, verifyIpa } = require("../../lib/ios.js");

run(async () => {
  const privateKey = input("app-store-connect-private-key");
  if (privateKey) mask(privateKey);
  const [archive, given] = [input("archive"), input("ipa")];
  if (!archive === !given) throw new Error("ios-publish needs either archive or ipa.");
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "ios-publish-"));
  const ipa = given || exportArchive(system, { archive, exportOptions: input("export-options"), directory: path.join(work, "export") });
  const build = { bundleId: input("bundle-id"), version: input("version"), buildNumber: input("build-number") };
  verifyIpa(system, { ipa, ...build, directory: path.join(work, "verify") });
  const dsyms = archive ? path.join(archive, "dSYMs") : "";
  record(process.env.GITHUB_OUTPUT, { ipa, dsyms });
  console.log(`Verified ${path.basename(ipa)} as ${build.bundleId} ${build.version} (${build.buildNumber}).`);
  if (input("upload") !== "true") return;
  const api = appStoreConnect({ keyId: input("app-store-connect-key-id"), issuerId: input("app-store-connect-issuer-id"), privateKey });
  const { buildId, uploaded } = await uploadToTestFlight(api, system, { ipa, ...build, commit: input("commit"), whatsNew: input("whats-new") });
  record(process.env.GITHUB_OUTPUT, { "build-id": buildId });
  console.log(`${uploaded ? "Uploaded" : "TestFlight already had"} ${build.version} (${build.buildNumber}); Apple lists it as build ${buildId}.`);
});
