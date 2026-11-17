"use strict";
const { run } = require("../../lib/release.js");
const { cleanup } = require("../../lib/ios.js");

// The runner runs this after the job, whether it passed or failed.
run(async () => {
  const env = process.env;
  cleanup({ keychain: env.STATE_keychain, profiles: env.STATE_profiles, directory: env.STATE_directory });
  console.log("Removed the signing keychain, the installed profiles and the App Store Connect key.");
});
