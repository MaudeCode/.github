"use strict";
const { run } = require("../../lib/release.js");
const { appStoreConnect, buildNumber, input, mask, record, system } = require("../../lib/ios.js");

run(async () => {
  const privateKey = input("app-store-connect-private-key");
  mask(privateKey);
  const api = appStoreConnect({ keyId: input("app-store-connect-key-id"), issuerId: input("app-store-connect-issuer-id"), privateKey });
  const commit = system.exec("git", ["rev-parse", "--verify", `${input("commit") || "HEAD"}^{commit}`]).trim();
  const [bundleId, version] = [input("bundle-id"), input("version")];
  const { number, uploaded } = await buildNumber(api, { bundleId, version, commit });
  record(process.env.GITHUB_OUTPUT, { "build-number": number, uploaded, commit });
  console.log(uploaded ? `${commit} already uploaded ${version} (${number}).` : `Building ${version} (${number}) from ${commit}.`);
});
