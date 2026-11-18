"use strict";
const { appendFileSync, readFileSync } = require("node:fs");
const { freeze, github, run } = require("../../lib/release.js");

run(async () => {
  const env = process.env;
  const mode = env.INPUT_MODE.trim();
  if (!["pull-request", "start", "end"].includes(mode)) throw new Error(`mode is "pull-request", "start" or "end", not ${JSON.stringify(mode)}.`);
  const api = github({ token: env.INPUT_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const repository = await api("GET", "");
  if (repository.status !== 200) throw new Error(`Reading the repository failed: HTTP ${repository.status}`);
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pull = event.pull_request && { number: event.pull_request.number, sha: event.pull_request.head.sha };
  if (mode === "pull-request" && !pull) throw new Error('mode "pull-request" runs on a pull_request_target or pull_request event.');
  const result = await freeze(api, { mode, workflow: env.INPUT_WORKFLOW, branch: repository.data.default_branch, runId: env.GITHUB_RUN_ID, pull });
  appendFileSync(env.GITHUB_OUTPUT, `frozen=${JSON.stringify(result.frozen)}\nthawed=${JSON.stringify(result.thawed)}\n`);
  console.log(`Frozen: ${result.frozen.join(", ") || "none"}. Thawed: ${result.thawed.join(", ") || "none"}.`);
});
