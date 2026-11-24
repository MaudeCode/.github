"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { gate, route, select, summary } = require("../lib/suites.js");

const config = {
  suites: { web: { prePush: ["pnpm run lint:ts"] }, cli: {}, docs: {} },
  rules: [
    { paths: ["**/*.md", "docs/**"], suites: [] },
    { paths: ["web/convex/**/*.test.ts"], suites: ["web"] },
    { paths: ["protocol/**"], suites: ["web", "cli"] },
    { paths: ["web/**"], suites: ["web", "docs"] },
    { paths: [".github/workflows/ci.yml", ".github/ci-suites.json"], suites: "*" },
  ],
};

test("the first rule that matches a path decides its suites, and a diff selects their union", () => {
  for (const [paths, selected, rules] of [
    [["web/convex/a/b.test.ts"], ["web"], [1]],
    [["web/convex/a/b.ts"], ["web", "docs"], [3]],
    [["web/README.md"], [], [0]],
    [["protocol/x.ts"], ["web", "cli"], [2]],
    [[".github/workflows/ci.yml"], ["web", "cli", "docs"], [4]],
    [["web/convex/a.test.ts", "protocol/y.ts"], ["web", "cli"], [1, 2]],
    [[], [], []],
  ]) {
    const result = select(config, paths);
    assert.deepEqual(result.selected, selected, paths.join(" "));
    assert.deepEqual(result.paths.map((entry) => entry.rule), rules, paths.join(" "));
  }
});

test("a path no rule may decide selects every suite", () => {
  for (const path of ["cli/main.go", "web/../secrets", "./web/a.ts", "web//a.ts", "/web/a.ts"]) {
    const [entry] = select(config, [path]).paths;
    assert.deepEqual(entry.suites, ["web", "cli", "docs"], path);
    assert.equal(entry.rule, null, path);
  }
});

test("a suites file that names an unknown suite, a rule without paths or an unknown key is refused, naming the key", () => {
  for (const [change, error] of [
    [{ rules: [{ paths: ["a/**"], suites: ["api"] }] }, /rules\[0\]\.suites names "api"/],
    [{ rules: [{ suites: ["web"] }] }, /rules\[0\]\.paths is missing/],
    [{ rules: [{ paths: [], suites: ["web"] }] }, /rules\[0\]\.paths is missing/],
    [{ rules: [{ paths: ["a/**"], suites: ["web"], suite: "cli" }] }, /rules\[0\]: "suite" is not a key/],
    [{ rule: [] }, /"rule" is not a key/],
    [{ suites: { web: { prepush: [] } } }, /suites\.web: "prepush" is not a key/],
    [{ suites: { base: {} } }, /suites\.base/],
  ]) assert.throws(() => select({ ...config, ...change }, []), error, JSON.stringify(change));
});

/** A git that knows one merge base and the diffs between named commits; anything else fails like git. */
function fakeGit(diffs, mergeBases = {}) {
  return (args) => {
    const pair = args.slice(2).join(" ");
    if (args[0] === "merge-base" && mergeBases[pair]) return `${mergeBases[pair]}\n`;
    if (args[0] === "diff") {
      const range = args.slice(5, -1).join(" ");
      if (Object.hasOwn(diffs, range)) return diffs[range].map((path) => `${path}\0`).join("");
    }
    throw Object.assign(new Error(`git ${args.join(" ")} failed`), { stderr: "fatal: bad revision\n" });
  };
}

/** This workflow's push runs on main, newest first, as the runs endpoint lists them. */
function runsApi(runs, calls = []) {
  return async (method, path) => {
    calls.push(path);
    if (method === "GET" && path === "/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=50") return { status: 200, data: { workflow_runs: runs } };
    return { status: 404, data: { message: "Not Found" } };
  };
}

const push = { eventName: "push", event: { repository: { default_branch: "main" } }, ref: "refs/heads/main", sha: "head", runNumber: 10, workflowRef: "o/r/.github/workflows/ci.yml@refs/heads/main" };

test("a pull request tests its diff from the merge base", async () => {
  const event = { pull_request: { base: { sha: "main" }, head: { sha: "topic" } }, repository: { default_branch: "main" } };
  const git = fakeGit({ "fork topic": ["protocol/a.ts"] }, { "main topic": "fork" });
  const routed = await route(config, { git, api: runsApi([]) }, { ...push, eventName: "pull_request", event, ref: "refs/pull/1/merge" });
  assert.equal(routed.base, "fork");
  assert.deepEqual(routed.result.selected, ["web", "cli"]);
});

test("a push tests its diff from the newest earlier run that passed, skipping failed and cancelled ones", async () => {
  const runs = [
    { run_number: 11, conclusion: "success", head_sha: "later" },
    { run_number: 10, conclusion: null, head_sha: "head" },
    { run_number: 9, conclusion: "failure", head_sha: "failed" },
    { run_number: 8, conclusion: "cancelled", head_sha: "cancelled" },
    { run_number: 7, conclusion: "success", head_sha: "passed" },
    { run_number: 6, conclusion: "success", head_sha: "older" },
  ];
  const routed = await route(config, { git: fakeGit({ "passed head": ["web/a.ts", "README.md"] }), api: runsApi(runs) }, push);
  assert.equal(routed.base, "passed");
  assert.deepEqual(routed.result.selected, ["web", "docs"]);
});

test("every suite runs when there is no change to read", async () => {
  const git = fakeGit({});
  for (const [why, run, api] of [
    [/no earlier push run of ci\.yml on main passed/, push, runsApi([{ run_number: 9, conclusion: "failure", head_sha: "failed" }])],
    [/the diff from passed could not be read/, push, runsApi([{ run_number: 9, conclusion: "success", head_sha: "passed" }])],
    [/HTTP 404/, { ...push, workflowRef: "o/r/.github/workflows/other.yml@refs/heads/main" }, runsApi([])],
    [/a workflow_dispatch run on refs\/heads\/main tests every suite/, { ...push, eventName: "workflow_dispatch" }, runsApi([])],
    [/a push run on refs\/heads\/topic tests every suite/, { ...push, ref: "refs/heads/topic" }, runsApi([])],
    [/merge base of main and topic could not be found/, { ...push, eventName: "pull_request", event: { pull_request: { base: { sha: "main" }, head: { sha: "topic" } } } }, runsApi([])],
  ]) {
    const routed = await route(config, { git, api }, run);
    assert.deepEqual(routed.result.selected, ["web", "cli", "docs"], String(why));
    assert.match(routed.result.why, why);
    assert.equal(routed.base, "");
  }
});

test("the job summary names the first path and rule that selected each suite", () => {
  const result = select(config, ["web/a.test.ts", "web/convex/b.test.ts", "web/c.ts"]);
  const text = summary(config, { base: "f".repeat(40), result });
  assert.match(text, /\| web \| yes \| `web\/a\.test\.ts` \| rules\[3\] \(web\/\*\*\) \|/);
  assert.match(text, /\| docs \| yes \| `web\/a\.test\.ts` \| rules\[3\] \(web\/\*\*\) \|/);
  assert.match(text, /\| cli \| no \| {2}\| {2}\|/);
});

test("the CI gate passes when every required job succeeded and every other suite job succeeded or was skipped", () => {
  const needs = { changes: { result: "success" }, web: { result: "success" }, cli: { result: "skipped" }, docs: { result: "success" } };
  assert.deepEqual(gate({ needs, selected: ["web"] }), []);
  for (const [change, selected, failure] of [
    [{ web: { result: "failure" } }, ["web"], /^web ended failure, and it runs web/],
    [{ web: { result: "cancelled" } }, ["web"], /^web ended cancelled/],
    [{ web: { result: "skipped" } }, ["web"], /^web ended skipped/],
    [{ docs: { result: "failure" } }, ["web"], /^docs ended failure\.$/m],
    [{ changes: { result: "failure" } }, "", /^changes ended failure\.$/m],
    [{}, ["api"], /^api runs api, which this change selected, but the gate does not need it/m],
  ]) assert.match(gate({ needs: { ...needs, ...change }, selected }).join("\n"), failure, JSON.stringify(change));
});

test("with a jobs map, a job is required when any suite it runs was selected, and any other job must succeed", () => {
  const jobs = { app: ["web", "docs"], cli: ["cli"] };
  const needs = { changes: { result: "success" }, app: { result: "success" }, cli: { result: "skipped" } };
  assert.deepEqual(gate({ needs, selected: ["docs"], jobs }), []);
  for (const [change, selected, failure] of [
    [{ app: { result: "failure" } }, ["docs"], /^app ended failure, and it runs docs/],
    [{ app: { result: "skipped" } }, ["web"], /^app ended skipped, and it runs web/],
    [{ app: { result: "failure" }, cli: { result: "success" } }, ["cli"], /^app ended failure\.$/m],
    [{ changes: { result: "skipped" } }, ["docs"], /^changes ended skipped; every job the gate needs besides the suites must succeed/],
  ]) assert.match(gate({ needs: { ...needs, ...change }, selected, jobs }).join("\n"), failure, JSON.stringify(change));
  const split = { web_unit: ["web"], web_e2e: ["web"] };
  assert.match(gate({ needs: { changes: needs.changes, web_unit: { result: "success" } }, selected: ["web"], jobs: split }).join("\n"), /^web_e2e runs web, which this change selected, but the gate does not need it\.$/m);
  assert.match(gate({ needs, selected: ["api"], jobs }).join("\n"), /^api was selected, but no job in jobs runs it\.$/m);
});
