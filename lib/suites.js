"use strict";
// Which CI suites a change reaches, and whether the jobs that ran them passed (CI.md). No dependencies: the actions and
// the maudecode-ci command run on Node alone.
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { posix } = require("node:path");

/** Output names the ci-suites action sets besides one per suite, so no suite may take them. */
const RESERVED = ["suites", "base"];

function keysOnly(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${where}${JSON.stringify(key)} is not a key of the suites file; use ${allowed.join(" or ")}.`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** Throw, naming the offending key, unless `config` is a valid suites file. */
function check(config) {
  if (!isObject(config)) throw new Error("The suites file is a JSON object with suites and rules.");
  keysOnly(config, ["suites", "rules"], "");
  if (!isObject(config.suites) || !Object.keys(config.suites).length) throw new Error("suites names at least one suite.");
  for (const [name, suite] of Object.entries(config.suites)) {
    if (RESERVED.includes(name)) throw new Error(`suites.${name}: ${JSON.stringify(name)} is an output of its own; name the suite something else.`);
    if (!isObject(suite)) throw new Error(`suites.${name} is an object, such as {} or { "prePush": ["pnpm run lint"] }.`);
    keysOnly(suite, ["prePush"], `suites.${name}: `);
    if (suite.prePush !== undefined && !isStrings(suite.prePush)) throw new Error(`suites.${name}.prePush is a list of commands.`);
  }
  if (!Array.isArray(config.rules)) throw new Error("rules is a list of { paths, suites }.");
  config.rules.forEach((rule, i) => {
    if (!isObject(rule)) throw new Error(`rules[${i}] is an object with paths and suites.`);
    keysOnly(rule, ["paths", "suites"], `rules[${i}]: `);
    if (!isStrings(rule.paths) || !rule.paths.length) throw new Error(`rules[${i}].paths is missing; a rule names at least one glob.`);
    if (rule.suites === "*") return;
    if (!Array.isArray(rule.suites)) throw new Error(`rules[${i}].suites is "*" or a list of suites.`);
    const unknown = rule.suites.find((name) => !Object.hasOwn(config.suites, name));
    if (unknown !== undefined) throw new Error(`rules[${i}].suites names ${JSON.stringify(unknown)}, which is not in suites.`);
  });
}

/** The suites file at `file`, checked. */
function readConfig(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Reading ${file} failed: ${error.message}`);
  }
  try {
    check(config);
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  return config;
}

/** The rule that decides `path`: its index and the glob that matched, or a reason no rule may decide it. */
function decide(rules, path) {
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return { rule: null, why: "not a plain repository path" };
  for (const [i, rule] of rules.entries()) {
    const glob = rule.paths.find((pattern) => posix.matchesGlob(path, pattern));
    if (glob !== undefined) return { rule: i, glob };
  }
  return { rule: null, why: "no rule matches it" };
}

/**
 * The suites a change to `paths` selects. Rules are read in order, and the first one with a glob matching a path
 * decides that path's suites. A path no rule decides selects every suite: uncertainty runs everything.
 * @returns {{ selected: string[], paths: { path: string, rule: number | null, glob?: string, why?: string, suites: string[] }[] }}
 *   `selected` in the order the suites file names them; `rule` is the index of the rule that decided each path
 */
function select(config, paths) {
  check(config);
  const names = Object.keys(config.suites);
  const chosen = new Set();
  const decided = paths.map((path) => {
    const decision = decide(config.rules, path);
    const named = decision.rule === null ? "*" : config.rules[decision.rule].suites;
    const suites = named === "*" ? names : named;
    for (const name of suites) chosen.add(name);
    return { path, ...decision, suites: [...suites] };
  });
  return { selected: names.filter((name) => chosen.has(name)), paths: decided };
}

/** Every suite, because the change could not be read: `why` says so. */
function everything(config, why) {
  return { selected: Object.keys(config.suites), paths: [], why };
}

/** Run git in `cwd` and return its output; throws when git fails. */
function gitIn(cwd) {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The paths a diff touches. A rename or a deletion counts under its old path and its new one, because renames are
 * not followed (which also keeps a blobless clone from fetching contents).
 */
function changedPaths(git, from, to, { mergeBase = false } = {}) {
  const range = mergeBase ? [`${from}...${to}`] : [from, to];
  return git(["diff", "--name-only", "--no-renames", "-z", "--end-of-options", ...range, "--"]).split("\0").filter(Boolean);
}

/** `select` over a diff, or every suite when the diff cannot be read. */
function selectDiff(config, git, from, to, options) {
  let paths;
  try {
    paths = changedPaths(git, from, to, options);
  } catch (error) {
    return everything(config, `the diff from ${from} could not be read (${firstLine(error)})`);
  }
  return select(config, paths);
}

/** The first line of what a failed command said. */
const firstLine = (error) => String(error.stderr || error.message).trim().split("\n")[0];

/** The head commit of the newest earlier push run of `workflow` on `branch` that succeeded, among its last 50. */
async function lastPassed(api, { workflow, branch, runNumber }) {
  const runs = await api("GET", `/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=50`);
  if (runs.status !== 200) throw new Error(`reading this workflow's runs failed: HTTP ${runs.status} (the job needs actions: read)`);
  // Newest first. A failed or cancelled run is no base, so what it failed runs again.
  return runs.data.workflow_runs.find((run) => run.run_number < runNumber && run.conclusion === "success")?.head_sha ?? null;
}

/**
 * The suites a workflow run tests. A pull request tests its diff from the merge base; a push to the default branch,
 * its diff from the last commit this workflow passed on there; anything else, every suite.
 * @param {{ eventName: string, event: object, ref: string, sha: string, runNumber: number, workflowRef: string }} run
 * @returns {Promise<{ base: string, result: ReturnType<typeof select> & { why?: string } }>} `base` is empty when every suite runs without a diff
 */
async function route(config, { git, api }, { eventName, event, ref, sha, runNumber, workflowRef }) {
  if (eventName === "pull_request") {
    const [from, to] = [event.pull_request.base.sha, event.pull_request.head.sha];
    let base;
    try {
      base = git(["merge-base", "--end-of-options", from, to]).trim();
    } catch (error) {
      return { base: "", result: everything(config, `the merge base of ${from.slice(0, 7)} and ${to.slice(0, 7)} could not be found (${firstLine(error)})`) };
    }
    return compared(base, selectDiff(config, git, base, to));
  }
  const branch = event.repository?.default_branch;
  if (eventName !== "push" || ref !== `refs/heads/${branch}`) return { base: "", result: everything(config, `a ${eventName} run on ${ref} tests every suite`) };
  // owner/repo/.github/workflows/ci.yml@refs/heads/main
  const workflow = posix.basename(workflowRef.split("@")[0]);
  let base;
  try {
    base = await lastPassed(api, { workflow, branch, runNumber });
  } catch (error) {
    return { base: "", result: everything(config, error.message) };
  }
  if (!base) return { base: "", result: everything(config, `no earlier push run of ${workflow} on ${branch} passed among its last 50`) };
  return compared(base, selectDiff(config, git, base, sha));
}

/** A diff that could not be read compared nothing, so it names no base. */
const compared = (base, result) => ({ base: result.why ? "" : base, result });

/** How a rule is named to a person: its number in the file and the glob that matched. */
function ruleName(entry) {
  return entry.rule === null ? entry.why : `rules[${entry.rule}] (${entry.glob})`;
}

/** For each selected suite, the first path that selected it. */
function firstPaths(result) {
  const first = new Map();
  for (const entry of result.paths) for (const name of entry.suites) if (!first.has(name)) first.set(name, entry);
  return first;
}

/** The job summary: what was compared, and why each selected suite runs. */
function summary(config, { base, result }) {
  const lines = ["### CI suites", ""];
  if (result.why) lines.push(`Every suite runs: ${result.why}.`, "");
  else lines.push(`Compared with \`${base.slice(0, 12)}\`: ${result.paths.length} changed path${result.paths.length === 1 ? "" : "s"}.`, "");
  const first = firstPaths(result);
  lines.push("| Suite | Runs | First path that selected it | Rule |", "| --- | --- | --- | --- |");
  for (const name of Object.keys(config.suites)) {
    const entry = first.get(name);
    const runs = result.selected.includes(name);
    lines.push(`| ${name} | ${runs ? "yes" : "no"} | ${entry ? `\`${entry.path}\`` : ""} | ${entry ? ruleName(entry) : ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** One `# path: rule -> suites` line per changed path, for `maudecode-ci suites --explain`. */
function explain(result) {
  if (result.why) return [`# every suite: ${result.why}`];
  return result.paths.map((entry) => `# ${entry.path}: ${ruleName(entry)} -> ${entry.suites.join(", ") || "no suite"}`);
}

/**
 * Why the CI Gate fails, or an empty list when it passes. A job is required when any suite it runs was selected, and
 * must have succeeded; a suite job that is not required may also have been skipped; any other needed job, such as
 * the router, must have succeeded. Without `jobs`, each suite runs in a job named after it, and a needed job that
 * runs no selected suite counts as a suite job that was not required.
 * @param {{ needs: Record<string, { result: string }>, selected: unknown, jobs?: Record<string, string[]> }} ci
 */
function gate({ needs, selected, jobs }) {
  const failures = [];
  const chosen = isStrings(selected) ? selected : null;
  if (!chosen) failures.push(`No suite selection reached the gate (selected is ${JSON.stringify(selected)}): the router job did not finish.`);
  if (jobs !== undefined && (!isObject(jobs) || !Object.values(jobs).every(isStrings))) throw new Error('jobs maps each job to the suites it runs, such as {"web": ["web", "api"]}.');
  const runs = (id) => (jobs ? jobs[id] : [id]);
  for (const [id, { result }] of Object.entries(needs)) {
    const suites = runs(id);
    const required = suites?.filter((name) => chosen?.includes(name)) ?? [];
    if (required.length && result !== "success") failures.push(`${id} ended ${result}, and it runs ${required.join(", ")}, which this change selected.`);
    else if (!required.length && suites && !["success", "skipped"].includes(result)) failures.push(`${id} ended ${result}.`);
    else if (!suites && result !== "success") failures.push(`${id} ended ${result}; every job the gate needs besides the suites must succeed.`);
  }
  for (const name of chosen ?? []) {
    const ids = jobs ? Object.keys(jobs).filter((id) => jobs[id].includes(name)) : [name];
    if (!ids.length) failures.push(`${name} was selected, but no job in jobs runs it.`);
    // Every job that runs a selected suite, so one that is still running or failed cannot be left out.
    for (const id of ids) if (!Object.hasOwn(needs, id)) failures.push(`${id} runs ${name}, which this change selected, but the gate does not need it.`);
  }
  return failures;
}

module.exports = { check, readConfig, select, everything, firstLine, gitIn, changedPaths, selectDiff, route, summary, explain, gate };
