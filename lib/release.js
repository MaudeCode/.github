"use strict";
// The checks and the tagging every tag-last release workflow shares (RELEASES.md). No dependencies: the actions run on
// the runner's own Node.

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** `vX.Y.Z` with an optional prerelease and no build metadata, or null. */
function parseVersion(tag) {
  const match = VERSION.exec(tag);
  return match && { numbers: [1, 2, 3].map((i) => Number(match[i])), prerelease: match[4] ? match[4].split(".") : [] };
}

/** Semantic Versioning precedence: negative when `a` comes before `b`. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  // A release comes after its own prereleases.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const [x, y] = [a.prerelease[i], b.prerelease[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Why this run may not release `tag`, or null when it may. A release is a dispatch on the default branch, of the
 * commit the person who started it looked at, under a version that has not been used and comes after the last one.
 * @param {{ event: string, ref: string, defaultBranch: string, runSha: string, sha: string, tag: string, tags: string[] }} run
 */
function refusal({ event, ref, defaultBranch, runSha, sha, tag, tags }) {
  if (event !== "workflow_dispatch") return `A release is started by dispatching this workflow, not by ${event}.`;
  if (ref !== `refs/heads/${defaultBranch}`) return `A release runs on ${defaultBranch}, not ${ref}.`;
  const version = parseVersion(tag);
  if (!version) return `${JSON.stringify(tag)} is not a version tag such as v1.2.3 or v1.2.3-rc.1.`;
  if (!/^[0-9a-f]{40}$/.test(sha)) return "sha must be the full commit SHA to release.";
  if (sha !== runSha) return `${defaultBranch} is at ${runSha.slice(0, 7)}, not the ${sha.slice(0, 7)} this release was started for. Start it again for the new commit.`;
  if (tags.includes(tag)) return `${tag} already exists. A released version is not released again.`;
  const released = tags.map((name) => [name, parseVersion(name)]).filter(([, parsed]) => parsed);
  const latest = released.sort(([, a], [, b]) => compareVersions(a, b)).at(-1);
  if (latest && compareVersions(version, latest[1]) <= 0) return `${tag} does not come after ${latest[0]}, the latest version tag.`;
  return null;
}

/** GitHub's REST API for this repository, with the job's token. */
function github({ token, repository, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  return async function api(method, path, body) {
    const response = await fetch(path.startsWith("http") ? path : `${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body && JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    return { status: response.status, data, next: /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] };
  };
}

function failed(what, { status, data }) {
  return new Error(`${what}: HTTP ${status} ${data?.message ?? ""}`.trim());
}

/** Every `v…` tag name in the repository. */
async function versionTags(api) {
  const names = [];
  for (let path = "/git/matching-refs/tags/v?per_page=100"; path; ) {
    const page = await api("GET", path);
    if (page.status !== 200) throw failed("Listing tags failed", page);
    names.push(...page.data.map((ref) => ref.ref.replace(/^refs\/tags\//, "")));
    path = page.next;
  }
  return names;
}

/** The commit a tag names, through an annotated tag object; null when there is no such tag. */
async function taggedCommit(api, tag) {
  const ref = await api("GET", `/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status === 404) return null;
  if (ref.status !== 200) throw failed("Reading the tag failed", ref);
  if (ref.data.object.type === "commit") return ref.data.object.sha;
  const object = await api("GET", `/git/tags/${ref.data.object.sha}`);
  if (object.status !== 200) throw failed("Reading the tag failed", object);
  return object.data.object.sha;
}

/**
 * Create the annotated tag that marks a finished release. Running it again for the same commit succeeds, so a job
 * that is re-run does not fail on its own earlier work; the tag on another commit is refused.
 * @returns {Promise<"created" | "exists">}
 */
async function createTag(api, { tag, sha, message }) {
  const existing = await taggedCommit(api, tag);
  if (existing === sha) return "exists";
  if (existing) throw new Error(`${tag} already names ${existing.slice(0, 7)}, not ${sha.slice(0, 7)}.`);
  const object = await api("POST", "/git/tags", { tag, message, object: sha, type: "commit" });
  if (object.status !== 201) throw failed("Creating the tag failed", object);
  const ref = await api("POST", "/git/refs", { ref: `refs/tags/${tag}`, sha: object.data.sha });
  if (ref.status === 201) return "created";
  // Another attempt got there between the look and the write.
  if ((await taggedCommit(api, tag)) === sha) return "exists";
  throw failed("Creating the tag failed", ref);
}

/** Run an action's body, turning a thrown error into the job's failure message. */
function run(main) {
  main().catch((error) => {
    console.log(`::error::${String(error.message).replace(/\r?\n/g, " ")}`);
    process.exitCode = 1;
  });
}

module.exports = { parseVersion, compareVersions, refusal, github, versionTags, taggedCommit, createTag, run };
