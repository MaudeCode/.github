"use strict";
const os = require("node:os");
const { run } = require("../../lib/release.js");
const { input, mask, record, setUpSigning } = require("../../lib/ios.js");

run(async () => {
  const secrets = {
    p12: input("certificate-p12-base64"), password: input("certificate-password"), privateKey: input("app-store-connect-private-key"),
  };
  Object.values(secrets).forEach(mask);
  const outputs = await setUpSigning({
    ...secrets,
    keyId: input("app-store-connect-key-id"),
    issuerId: input("app-store-connect-issuer-id"),
    bundleIds: input("bundle-ids").split(/[\s,]+/).filter(Boolean),
    internalTestingOnly: input("internal-testing-only") === "true",
  }, { temp: process.env.RUNNER_TEMP || os.tmpdir(), home: os.homedir(), save: (name, value) => record(process.env.GITHUB_STATE, { [name]: value }) });
  record(process.env.GITHUB_OUTPUT, outputs);
  console.log(`Signing as team ${outputs["team-id"]} with ${outputs.profiles}.`);
});
