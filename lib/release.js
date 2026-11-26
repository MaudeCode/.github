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

/** The latest version tag among `tags`, or undefined when there is none. */
function latestVersion(tags) {
  return tags.filter(parseVersion).sort((a, b) => compareVersions(parseVersion(a), parseVersion(b))).at(-1);
}

/**
 * Why this run may not release `tag`, or null when it may. A release is a dispatch on the default branch, under a
 * version that has not been used and comes after the last one. `earlierCommitRefusal` checks a commit other than the run's.
 * @param {{ event: string, ref: string, defaultBranch: string, runSha: string, sha: string, tag: string, tags: string[] }} run
 */
function refusal({ event, ref, defaultBranch, runSha, sha, tag, tags }) {
  if (event !== "workflow_dispatch") return `A release is started by dispatching this workflow, not by ${event}.`;
  if (ref !== `refs/heads/${defaultBranch}`) return `A release runs on ${defaultBranch}, not ${ref}.`;
  const version = parseVersion(tag);
  if (!version) return `${JSON.stringify(tag)} is not a version tag such as v1.2.3 or v1.2.3-rc.1.`;
  // Left empty, the release is of the commit the run is on: the default branch's head when it was started.
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) return "sha must be the full commit SHA to release, or empty for the default branch's head.";
  if (tags.includes(tag)) return `${tag} already exists. A released version is not released again.`;
  const latest = latestVersion(tags);
  if (latest && compareVersions(version, parseVersion(latest)) <= 0) return `${tag} does not come after ${latest}, the latest version tag.`;
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
 * Why `sha`, a commit other than the one the run is on, may not be released, or null when it may. It must be on the
 * default branch after the last release, with the workflow files the branch has now: GitHub refuses a workflow's
 * token that tags a commit whose workflow files differ from the default branch's.
 * @param {{ sha: string, runSha: string, defaultBranch: string, latest: string | undefined }} release
 */
async function earlierCommitRefusal(api, { sha, runSha, defaultBranch, latest }) {
  const short = sha.slice(0, 7);
  const isBefore = async (base, head) => {
    const compared = await api("GET", `/compare/${base}...${head}`);
    if (compared.status === 404) return false;
    if (compared.status !== 200) throw failed("Comparing commits failed", compared);
    return compared.data.status === "ahead";
  };
  if (!(await isBefore(sha, runSha))) return `${short} is not a commit on ${defaultBranch}.`;
  const released = latest && (await taggedCommit(api, latest));
  if (released && !(await isBefore(released, sha))) return `${short} does not come after ${latest}, the last release.`;
  const workflows = async (commit) => {
    const listing = await api("GET", `/contents/.github?ref=${commit}`);
    if (listing.status === 404) return null;
    if (listing.status !== 200) throw failed("Reading the workflow files failed", listing);
    return listing.data.find((entry) => entry.name === "workflows")?.sha ?? null;
  };
  if ((await workflows(sha)) !== (await workflows(runSha))) {
    return `A workflow file changed between ${short} and ${defaultBranch}, and GitHub does not let a release tag such a commit. Release a newer commit.`;
  }
  return null;
}

/** Job conclusions across all pages of the latest attempt. */
async function runJobs(api, runId) {
  const jobs = [];
  for (let path = `/actions/runs/${runId}/jobs?filter=latest&per_page=100`; path; ) {
    const page = await api("GET", path);
    if (page.status !== 200) throw failed("Reading a run's jobs failed", page);
    jobs.push(...page.data.jobs);
    path = page.next;
  }
  return jobs;
}

/** Find the newest default-branch run that ran each check on the release commit. */
async function passedChecks(api, { sha, defaultBranch, checks }) {
  const pendingByWorkflow = new Map();
  const passed = {};
  const runs = {};
  for (const { workflow, job } of checks) {
    if (!pendingByWorkflow.has(workflow)) pendingByWorkflow.set(workflow, new Set());
    pendingByWorkflow.get(workflow).add(job);
    passed[`${workflow}: ${job}`] = false;
  }

  for (const [workflow, pending] of pendingByWorkflow) {
    const query = new URLSearchParams({ head_sha: sha, branch: defaultBranch, per_page: "20" });
    for (let path = `/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`; path && pending.size; ) {
      const page = await api("GET", path);
      if (page.status === 404) throw new Error(`${workflow} is not a workflow in this repository.`);
      if (page.status !== 200) throw failed("Reading workflow runs failed (the job needs actions: read)", page);
      for (const run of page.data.workflow_runs) {
        if (!["push", "workflow_dispatch", "schedule"].includes(run.event) ||
            run.head_sha !== sha || run.head_branch !== defaultBranch) continue;
        const jobs = await runJobs(api, run.id);
        for (const job of pending) {
          const matches = jobs.filter(({ name }) => job.endsWith("*") ? name.startsWith(job.slice(0, -1)) : name === job);
          if (!matches.length || matches.some(({ conclusion }) => conclusion === "skipped")) continue;
          const key = `${workflow}: ${job}`;
          passed[key] = matches.every(({ conclusion }) => conclusion === "success");
          runs[key] = run.html_url;
          pending.delete(job);
        }
        if (!pending.size) break;
      }
      path = page.next;
    }
  }
  return { passed, runs };
}

/** The `checks` input: one `workflow.yml: Job name` a line. */
function parseChecks(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(": ");
    if (at < 1 || !line.slice(at + 2).trim()) throw new Error(`${JSON.stringify(line)} is not a check such as "ci.yml: Checks".`);
    return { workflow: line.slice(0, at), job: line.slice(at + 2).trim() };
  });
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

/** The commit status a pull request carries while a release may not be disturbed. */
const FREEZE = "release-freeze";

/** Whether pull request `number` changes a workflow file. */
async function changesWorkflows(api, number) {
  for (let path = `/pulls/${number}/files?per_page=100`; path; ) {
    const page = await api("GET", path);
    if (page.status !== 200) throw failed("Reading the pull request's files failed", page);
    if (page.data.some((file) => [file.filename, file.previous_filename].some((name) => name?.startsWith(".github/workflows/")))) return true;
    path = page.next;
  }
  return false;
}

/** Whether a release run other than `except` is queued or running: a dispatch of `workflow` on the default branch. */
async function releaseRunning(api, { workflow, branch, except }) {
  for (const status of ["in_progress", "queued"]) {
    const runs = await api("GET", `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&status=${status}&per_page=20`);
    if (runs.status !== 200) throw failed("Reading release runs failed (the job needs actions: read)", runs);
    if (runs.data.workflow_runs.some((run) => String(run.id) !== String(except))) return true;
  }
  return false;
}

async function setFreeze(api, sha, frozen) {
  const body = frozen
    ? { state: "failure", description: "A release is running. This changes a workflow file, so it merges when the release finishes." }
    : { state: "success", description: "No release is running, or this changes no workflow file." };
  const posted = await api("POST", `/statuses/${sha}`, { ...body, context: FREEZE });
  if (posted.status !== 201) throw failed("Posting the status failed (the job needs statuses: write)", posted);
}

/**
 * Keep workflow changes from merging while a release runs: GitHub refuses a release's own token when it tags a commit
 * whose workflow files differ from the default branch's, so a workflow change that merges mid-release leaves the
 * release published and untagged. A pull request's push sets its own status; a release freezes the open pull
 * requests that change a workflow file when it starts and thaws them when it ends, however it ends.
 * @param {{ mode: "pull-request" | "start" | "end", workflow: string, branch: string, runId: string, pull?: { number: number, sha: string } }} event
 * @returns {Promise<{ frozen: number[], thawed: number[] }>} the pull requests whose status was set to each
 */
async function freeze(api, { mode, workflow, branch, runId, pull }) {
  const [frozen, thawed] = [[], []];
  const set = async ({ number, sha }, on) => {
    await setFreeze(api, sha, on);
    (on ? frozen : thawed).push(number);
  };
  if (mode === "pull-request") {
    await set(pull, (await changesWorkflows(api, pull.number)) && (await releaseRunning(api, { workflow, branch })));
    return { frozen, thawed };
  }
  // A release ending leaves the freeze in place while another is still going.
  const on = mode === "start" || (await releaseRunning(api, { workflow, branch, except: runId }));
  for (let path = "/pulls?state=open&per_page=100"; path; ) {
    const page = await api("GET", path);
    if (page.status !== 200) throw failed("Listing pull requests failed", page);
    for (const open of page.data) if (await changesWorkflows(api, open.number)) await set({ number: open.number, sha: open.head.sha }, on);
    path = page.next;
  }
  return { frozen, thawed };
}

/** Run an action's body, turning a thrown error into the job's failure message. */
function run(main) {
  main().catch((error) => {
    console.log(`::error::${String(error.message).replace(/\r?\n/g, " ")}`);
    process.exitCode = 1;
  });
}

module.exports = { parseVersion, compareVersions, latestVersion, refusal, earlierCommitRefusal, passedChecks, parseChecks, freeze, github, versionTags, taggedCommit, createTag, run };
