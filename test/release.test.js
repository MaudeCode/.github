"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compareVersions, createTag, earlierCommitRefusal, freeze, parseChecks, parseVersion, passedChecks, refusal, versionTags } = require("../lib/release.js");

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const release = { event: "workflow_dispatch", ref: "refs/heads/main", defaultBranch: "main", runSha: SHA, sha: SHA, tag: "v1.3.0", tags: ["v1.2.0", "v1.2.1", "nightly", "v9"] };

test("a release is a dispatch on the default branch, under an unused later version", () => {
  assert.equal(refusal(release), null);
  assert.equal(refusal({ ...release, tags: [] }), null);
  assert.equal(refusal({ ...release, tag: "v1.3.0-rc.1" }), null);
  assert.equal(refusal({ ...release, sha: "" }), null, "no sha releases the commit the run is on");
  assert.equal(refusal({ ...release, sha: OTHER }), null, "a commit other than the run's is checked by earlierCommitRefusal");
  for (const [change, reason] of [
    [{ event: "push" }, /started by dispatching/],
    [{ ref: "refs/heads/feature" }, /runs on main/],
    [{ ref: "refs/tags/v1.3.0" }, /runs on main/],
    [{ tag: "1.3.0" }, /not a version tag/],
    [{ tag: "v1.3" }, /not a version tag/],
    [{ tag: "v1.3.0+build" }, /not a version tag/],
    [{ sha: "abc123" }, /full commit SHA/],
    [{ tag: "v1.2.1" }, /already exists/],
    [{ tag: "v1.2.0-rc.1" }, /does not come after v1\.2\.1/],
    [{ tag: "v1.1.9" }, /does not come after v1\.2\.1/],
  ]) assert.match(refusal({ ...release, ...change }), reason, JSON.stringify(change));
});

test("versions order by Semantic Versioning precedence", () => {
  const ordered = ["v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0", "v1.0.1", "v1.10.0", "v2.0.0"];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(parseVersion(ordered[i - 1]), parseVersion(ordered[i])) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(parseVersion("v01.0.0"), null);
  assert.equal(parseVersion("v1.0.0-01"), null);
});

/** A repository's tags, behind the three endpoints the actions use. */
function repository(tags = {}) {
  const objects = {};
  const calls = [];
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/git/matching-refs/tags/v")) {
      const names = Object.keys(tags).filter((name) => name.startsWith("v"));
      const page = path.includes("page=2") ? names.slice(1) : names.slice(0, 1);
      return { status: 200, data: page.map((name) => ({ ref: `refs/tags/${name}` })), next: path.includes("page=2") || names.length < 2 ? undefined : `${path}&page=2` };
    }
    if (method === "GET" && path.startsWith("/git/ref/tags/")) {
      const tag = tags[decodeURIComponent(path.slice("/git/ref/tags/".length))];
      return tag ? { status: 200, data: { object: tag } } : { status: 404, data: { message: "Not Found" } };
    }
    if (method === "GET" && path.startsWith("/git/tags/")) return { status: 200, data: { object: { sha: objects[path.slice("/git/tags/".length)] } } };
    if (method === "POST" && path === "/git/tags") {
      const sha = `object-${Object.keys(objects).length}`;
      objects[sha] = body.object;
      return { status: 201, data: { sha } };
    }
    if (method === "POST" && path === "/git/refs") {
      const name = body.ref.replace("refs/tags/", "");
      if (tags[name]) return { status: 422, data: { message: "Reference already exists" } };
      tags[name] = { type: "tag", sha: body.sha };
      return { status: 201, data: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, tags, calls };
}

test("every page of version tags is read", async () => {
  const { api } = repository({ "v1.0.0": {}, "v1.1.0": {}, "v1.2.0": {} });
  assert.deepEqual(await versionTags(api), ["v1.0.0", "v1.1.0", "v1.2.0"]);
});

test("the tag is created once at the released commit; a re-run succeeds and another commit is refused", async () => {
  const repo = repository();
  assert.equal(await createTag(repo.api, { tag: "v1.3.0", sha: SHA, message: "demo 1.3.0" }), "created");
  assert.equal(repo.tags["v1.3.0"].type, "tag");
  const writes = () => repo.calls.filter((call) => call.startsWith("POST")).length;
  const before = writes();
  assert.equal(await createTag(repo.api, { tag: "v1.3.0", sha: SHA, message: "demo 1.3.0" }), "exists");
  assert.equal(writes(), before, "a re-run writes nothing");
  await assert.rejects(createTag(repo.api, { tag: "v1.3.0", sha: OTHER, message: "demo 1.3.0" }), /already names aaaaaaa, not bbbbbbb/);
  // A lightweight tag someone pushed by hand counts the same way.
  const manual = repository({ "v2.0.0": { type: "commit", sha: SHA } });
  assert.equal(await createTag(manual.api, { tag: "v2.0.0", sha: SHA, message: "demo 2.0.0" }), "exists");
});

test("an earlier commit is released when it is on the default branch after the last release with the same workflow files", async () => {
  const [HEAD, PICKED, RELEASED] = [SHA, OTHER, "c".repeat(40)];
  /** A history RELEASED < PICKED < HEAD, each commit with the id of its workflows directory. */
  const history = (order, workflows) => async (method, path) => {
    const compare = /^\/compare\/(\w+)\.\.\.(\w+)$/.exec(path);
    if (compare) {
      const [base, head] = [order.indexOf(compare[1]), order.indexOf(compare[2])];
      if (base < 0 || head < 0) return { status: 404, data: { message: "Not Found" } };
      return { status: 200, data: { status: base < head ? "ahead" : base === head ? "identical" : "behind" } };
    }
    if (path === "/git/ref/tags/v1.2.1") return { status: 200, data: { object: { type: "commit", sha: RELEASED } } };
    const contents = /^\/contents\/\.github\?ref=(\w+)$/.exec(path);
    if (contents) return { status: 200, data: [{ name: "workflows", sha: workflows[contents[1]] }] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const picked = { sha: PICKED, runSha: HEAD, defaultBranch: "main", latest: "v1.2.1" };
  const same = { [PICKED]: "w1", [HEAD]: "w1" };
  assert.equal(await earlierCommitRefusal(history([RELEASED, PICKED, HEAD], same), picked), null);
  assert.equal(await earlierCommitRefusal(history([PICKED, HEAD], same), { ...picked, latest: undefined }), null, "a first release");
  assert.match(await earlierCommitRefusal(history([RELEASED, HEAD], same), picked), /bbbbbbb is not a commit on main/);
  assert.match(await earlierCommitRefusal(history([RELEASED, HEAD, PICKED], same), picked), /bbbbbbb is not a commit on main/, "a commit ahead of the branch");
  assert.match(await earlierCommitRefusal(history([PICKED, RELEASED, HEAD], same), picked), /does not come after v1\.2\.1/);
  assert.match(await earlierCommitRefusal(history([RELEASED, PICKED, HEAD], { [PICKED]: "w1", [HEAD]: "w2" }), picked), /workflow file changed between bbbbbbb and main/);
});

test("preflight uses the newest eligible run that ran each check", async () => {
  const checks = parseChecks("ci.yml: App / App hosted tests\nci.yml: Suite *");
  const hosted = "App / App hosted tests";
  const run = (id, event, jobs, head_branch = "main", head_sha = SHA) => ({
    id, event, jobs, head_branch, head_sha, html_url: `https://github.test/runs/${id}`,
  });
  const push = run("selected", "push", { [hosted]: "skipped", "Suite 1": "success", "Suite 2": "skipped" });
  const full = run("full", "workflow_dispatch", { [hosted]: "success", "Suite 1": "success", "Suite 2": "success" });
  const ineligible = [
    run("topic", "workflow_dispatch", full.jobs, "topic"),
    run("pr", "pull_request", full.jobs),
    run("other", "push", full.jobs, "main", OTHER),
  ];
  const decide = (listed) => passedChecks(async (_, path) => {
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      const workflow_runs = query.has("event")
        ? listed.filter((item) => item.event === query.get("event") && item.head_sha === SHA).slice(0, 1)
        : listed;
      return { status: 200, data: { workflow_runs } };
    }
    const id = path.split("/")[3];
    const jobs = Object.entries(listed.find((item) => item.id === id).jobs).map(([name, conclusion]) => ({ name, conclusion }));
    return { status: 200, data: { jobs } };
  }, { sha: SHA, defaultBranch: "main", checks });
  const result = (app, suite, appRun, suiteRun) => ({
    passed: { "ci.yml: App / App hosted tests": app, "ci.yml: Suite *": suite },
    runs: Object.fromEntries([[checks[0].job, appRun], [checks[1].job, suiteRun]]
      .filter(([, id]) => id).map(([job, id]) => [`ci.yml: ${job}`, `https://github.test/runs/${id}`])),
  });
  assert.deepEqual(await decide([push, full]), result(true, true, "full", "full"), "selected push falls through to the full dispatch");
  assert.deepEqual(await decide([full, push]), result(true, true, "full", "full"));
  assert.deepEqual(await decide([push, { ...full, event: "schedule" }]), result(true, true, "full", "full"));
  assert.deepEqual(await decide([...ineligible, push]), result(false, false));
  for (const conclusion of ["failure", "cancelled", null]) {
    assert.deepEqual(await decide([...ineligible, run("newer", "push", { [hosted]: conclusion }), full]),
      result(false, true, "newer", "full"));
  }
});

test("preflight evaluates job conclusions and suites across job pages", async () => {
  /** Each workflow's run on SHA, represented by its jobs and their conclusions. */
  const repository = (runs) => async (method, path) => {
    const listed = /^\/actions\/workflows\/([^/]+)\/runs\?head_sha=(\w+)&branch=main&per_page=20$/.exec(path);
    if (listed) {
      const workflow = decodeURIComponent(listed[1]);
      if (!(workflow in runs)) return { status: 404, data: { message: "Not Found" } };
      return { status: 200, data: { workflow_runs: listed[2] === SHA && runs[workflow] ? [{ id: workflow, event: "push", head_sha: SHA, head_branch: "main", html_url: `https://github.test/runs/${workflow}` }] : [] } };
    }
    const jobs = /^\/actions\/runs\/([^/]+)\/jobs\?filter=latest&per_page=100(&page=2)?$/.exec(path);
    if (jobs) {
      const all = Object.entries(runs[jobs[1]]).map(([name, conclusion]) => ({ name, conclusion }));
      return jobs[2] ? { status: 200, data: { jobs: all.slice(1) } } : { status: 200, data: { jobs: all.slice(0, 1) }, next: all.length > 1 ? `${path}&page=2` : undefined };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const checks = parseChecks("ci.yml: Checks\n  ci.yml: Browser (1/4)\n\nverify.yml: Tests\n");
  assert.deepEqual(checks, [{ workflow: "ci.yml", job: "Checks" }, { workflow: "ci.yml", job: "Browser (1/4)" }, { workflow: "verify.yml", job: "Tests" }]);
  // A job that passed counts though a sibling failed; one still running, skipped or absent does not, nor a workflow with no run.
  const api = repository({ "ci.yml": { "Docker (arm64)": "failure", "Browser (1/4)": null, Checks: "success" }, "verify.yml": null });
  assert.deepEqual(await passedChecks(api, { sha: SHA, defaultBranch: "main", checks }), {
    passed: { "ci.yml: Checks": true, "ci.yml: Browser (1/4)": false, "verify.yml: Tests": false },
    // Where each was read from, for a release to link to; a workflow with no run on the commit has none.
    runs: { "ci.yml: Checks": "https://github.test/runs/ci.yml", "ci.yml: Browser (1/4)": "https://github.test/runs/ci.yml" },
  });
  assert.deepEqual(await passedChecks(api, { sha: OTHER, defaultBranch: "main", checks: checks.slice(0, 1) }), { passed: { "ci.yml: Checks": false }, runs: {} }, "another commit's run is not this one's");
  assert.deepEqual(await passedChecks(api, { sha: SHA, defaultBranch: "main", checks: [] }), { passed: {}, runs: {} });
  // A name ending in * is a suite: every job that starts with it, at least one, all passed.
  const suites = repository({ "ci.yml": { "web / server (1/2)": "success", "web / server (2/2)": "success", "web / e2e (1/2)": "success", "web / e2e (2/2)": "skipped", "relay / check": "success" } });
  const suite = (job) => passedChecks(suites, { sha: SHA, defaultBranch: "main", checks: [{ workflow: "ci.yml", job }] }).then(({ passed }) => Object.values(passed)[0]);
  assert.equal(await suite("web / server *"), true);
  assert.equal(await suite("web / e2e *"), false, "one skipped job");
  assert.equal(await suite("web / *"), false, "the whole of web includes the skipped one");
  assert.equal(await suite("app / *"), false, "a suite with no jobs has not passed");
  assert.equal(await suite("relay / *"), true);
  await assert.rejects(passedChecks(api, { sha: SHA, defaultBranch: "main", checks: [{ workflow: "missing.yml", job: "Checks" }] }), /missing\.yml is not a workflow/);
  assert.throws(() => parseChecks("Checks"), /not a check such as/);
});

test("a pull request that changes a workflow file is frozen while a release runs, and thawed when the last one ends", async () => {
  /** Open pull requests by number, each with the files it changes, and the release runs going on, by id. */
  const repository = (pulls, releases) => {
    const statuses = {};
    const api = async (method, path, body) => {
      const files = /^\/pulls\/(\d+)\/files\?per_page=100$/.exec(path);
      if (files) return { status: 200, data: pulls[files[1]].map((filename) => ({ filename })) };
      if (path === "/pulls?state=open&per_page=100") return { status: 200, data: Object.keys(pulls).map((number) => ({ number: Number(number), head: { sha: `sha${number}` } })) };
      const runs = /^\/actions\/workflows\/release\.yml\/runs\?event=workflow_dispatch&branch=main&status=(\w+)&per_page=20$/.exec(path);
      if (runs) return { status: 200, data: { workflow_runs: (releases[runs[1]] ?? []).map((id) => ({ id })) } };
      const status = /^\/statuses\/(\w+)$/.exec(path);
      if (method === "POST" && status && body.context === "release-freeze") return (statuses[status[1]] = body.state), { status: 201, data: {} };
      throw new Error(`unexpected ${method} ${path}`);
    };
    return { api, statuses };
  };
  const pulls = { 1: ["src/app.ts"], 2: ["src/app.ts", ".github/workflows/ci.yml"], 3: ["docs/a.md"] };
  const on = { workflow: "release.yml", branch: "main", runId: "70" };

  // A release starting freezes only what changes a workflow file; ending thaws it, whatever the release's result.
  const quiet = repository(pulls, {});
  assert.deepEqual(await freeze(quiet.api, { ...on, mode: "start" }), { frozen: [2], thawed: [] });
  assert.deepEqual(quiet.statuses, { sha2: "failure" });
  assert.deepEqual(await freeze(quiet.api, { ...on, mode: "end" }), { frozen: [], thawed: [2] });
  assert.deepEqual(quiet.statuses, { sha2: "success" });
  // This run still counts as going on while its own last job runs; another release keeps the freeze.
  assert.deepEqual(await freeze(repository(pulls, { in_progress: [70] }).api, { ...on, mode: "end" }), { frozen: [], thawed: [2] });
  assert.deepEqual(await freeze(repository(pulls, { in_progress: [70], queued: [71] }).api, { ...on, mode: "end" }), { frozen: [2], thawed: [] });

  // A push to a pull request sets its own status, so one opened or changed mid-release is caught too.
  const pushed = (number, releases) => freeze(repository(pulls, releases).api, { ...on, mode: "pull-request", pull: { number, sha: `sha${number}` } });
  assert.deepEqual(await pushed(2, { queued: [71] }), { frozen: [2], thawed: [] });
  assert.deepEqual(await pushed(2, {}), { frozen: [], thawed: [2] }, "no release is running");
  assert.deepEqual(await pushed(1, { in_progress: [71] }), { frozen: [], thawed: [1] }, "it changes no workflow file");
  // A renamed workflow file counts by its old name too.
  const renamed = repository({ 4: [] }, { in_progress: [71] });
  const withRename = async (method, path, body) => (path.startsWith("/pulls/4/files") ? { status: 200, data: [{ filename: "old.yml", previous_filename: ".github/workflows/old.yml" }] } : renamed.api(method, path, body));
  assert.deepEqual(await freeze(withRename, { ...on, mode: "pull-request", pull: { number: 4, sha: "sha4" } }), { frozen: [4], thawed: [] });
});
