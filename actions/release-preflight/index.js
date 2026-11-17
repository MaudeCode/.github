"use strict";
const { appendFileSync } = require("node:fs");
const { earlierCommitRefusal, github, latestVersion, refusal, run, versionTags } = require("../../lib/release.js");

run(async () => {
  const env = process.env;
  const api = github({ token: env.INPUT_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const repository = await api("GET", "");
  if (repository.status !== 200) throw new Error(`Reading the repository failed: HTTP ${repository.status}`);
  const [tag, given] = [env.INPUT_TAG.trim(), (env.INPUT_SHA ?? "").trim()];
  const [defaultBranch, runSha, tags] = [repository.data.default_branch, env.GITHUB_SHA, await versionTags(api)];
  const sha = given || runSha;
  const why =
    refusal({ event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, defaultBranch, runSha, sha: given, tag, tags }) ??
    (sha === runSha ? null : await earlierCommitRefusal(api, { sha, runSha, defaultBranch, latest: latestVersion(tags) }));
  if (why) throw new Error(why);
  // GitHub does not infer a prerelease from the tag; the release step passes this on.
  appendFileSync(env.GITHUB_OUTPUT, `tag=${tag}\nversion=${tag.slice(1)}\nsha=${sha}\nprerelease=${tag.includes("-")}\n`);
  console.log(`Releasing ${tag} from ${sha}.`);
});
