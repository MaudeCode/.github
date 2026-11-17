"use strict";
const { appendFileSync } = require("node:fs");
const { github, refusal, run, versionTags } = require("../../lib/release.js");

run(async () => {
  const env = process.env;
  const api = github({ token: env.INPUT_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const repository = await api("GET", "");
  if (repository.status !== 200) throw new Error(`Reading the repository failed: HTTP ${repository.status}`);
  const [tag, sha] = [env.INPUT_TAG.trim(), env.INPUT_SHA.trim()];
  const why = refusal({
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, defaultBranch: repository.data.default_branch,
    runSha: env.GITHUB_SHA, sha, tag, tags: await versionTags(api),
  });
  if (why) throw new Error(why);
  appendFileSync(env.GITHUB_OUTPUT, `tag=${tag}\nversion=${tag.slice(1)}\nsha=${sha}\n`);
  console.log(`Releasing ${tag} from ${sha}.`);
});
