"use strict";
const { createTag, github, parseVersion, run } = require("../../lib/release.js");

run(async () => {
  const env = process.env;
  const [tag, sha] = [env.INPUT_TAG.trim(), env.INPUT_SHA.trim()];
  if (!parseVersion(tag) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("release-tag needs a version tag and a full commit SHA.");
  const api = github({ token: env.INPUT_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const message = env.INPUT_MESSAGE || `${env.GITHUB_REPOSITORY.split("/")[1]} ${tag.slice(1)}`;
  const outcome = await createTag(api, { tag, sha, message });
  console.log(outcome === "created" ? `Tagged ${sha} as ${tag}.` : `${tag} already names ${sha}.`);
});
