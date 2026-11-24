"use strict";
const { appendFileSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { github, run } = require("../../lib/release.js");
const { gitIn, readConfig, route, summary } = require("../../lib/suites.js");

// Sets one true or false output per suite besides suites and base.
run(async () => {
  const env = process.env;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const config = readConfig(resolve(workspace, env.INPUT_CONFIG));
  const api = github({ token: env.INPUT_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const routed = await route(config, { git: gitIn(workspace), api }, {
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    runNumber: Number(env.GITHUB_RUN_NUMBER),
    workflowRef: env.GITHUB_WORKFLOW_REF,
  });
  const { selected } = routed.result;
  const flags = Object.keys(config.suites).map((name) => `${name}=${selected.includes(name)}\n`).join("");
  appendFileSync(env.GITHUB_OUTPUT, `${flags}suites=${JSON.stringify(selected)}\nbase=${routed.base}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary(config, routed));
  console.log(routed.result.why ? `Every suite runs: ${routed.result.why}.` : `Compared with ${routed.base}.`);
  console.log(`Selected: ${selected.join(", ") || "none"}.`);
});
