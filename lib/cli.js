"use strict";
// maudecode-ci: the CI suite selection on a developer's machine, and the test checks (CI.md).
const { resolve } = require("node:path");
const { parseArgs } = require("node:util");
const { everything, explain, firstLine, readConfig, selectDiff } = require("./suites.js");
const { rules } = require("./rules.js");
const { testDurations } = require("./durations.js");

const USAGE = `Usage:
  maudecode-ci suites --base <ref> [--head HEAD] [--merge-base] [--config <path>] [--explain]
  maudecode-ci pre-push   (Git's pre-push hook; reads the pushed refs on stdin)
  maudecode-ci rules --config <path> [--update]
  maudecode-ci test-durations --config <path> REPORT...`;

const NONE = /^0+$/;

/**
 * Run a subcommand and return its exit code.
 * @param {string[]} argv the arguments after the command's name
 * @param {{ git: (args: string[]) => string, exec: (command: string, cwd: string) => { status: number, output: string },
 *   stdin: () => string, out: (line: string) => void, err: (line: string) => void, now: () => number, cwd: string }} io
 */
function main(argv, io) {
  const [command, ...rest] = argv;
  try {
    if (command === "suites") return suites(rest, io);
    if (command === "pre-push") return prePush(rest, io);
    if (command === "rules") return rules(rest, io);
    if (command === "test-durations") return testDurations(rest, io);
  } catch (error) {
    io.err(error.message);
    return 1;
  }
  io.err(USAGE);
  return 2;
}

function configAt(io, path) {
  const root = io.git(["rev-parse", "--show-toplevel"]).trim();
  return { root, config: readConfig(resolve(root, path ?? ".github/ci-suites.json")) };
}

/** Print `name=true|false` for each suite the diff from `--base` reaches. */
function suites(argv, io) {
  const { values } = parseArgs({
    args: argv,
    options: { base: { type: "string" }, head: { type: "string", default: "HEAD" }, "merge-base": { type: "boolean" }, config: { type: "string" }, explain: { type: "boolean" } },
  });
  if (!values.base) throw new Error(`--base is required.\n${USAGE}`);
  const { config } = configAt(io, values.config);
  const result = selectDiff(config, io.git, values.base, values.head, { mergeBase: values["merge-base"] });
  for (const name of Object.keys(config.suites)) io.out(`${name}=${result.selected.includes(name)}`);
  if (values.explain) for (const line of explain(result)) io.out(line);
  return 0;
}

/**
 * Git's pre-push hook: run the prePush commands of every suite the branch's change from the default branch reaches.
 * Each stdin line is `<local ref> <local sha> <remote ref> <remote sha>`.
 */
function prePush(argv, io) {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" } }, allowPositionals: true });
  const pushed = io.stdin().split("\n").map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length === 4);
  // A tag carries no change to check, and a deletion pushes nothing.
  const branches = pushed.filter(([localRef, localSha, remoteRef]) => !NONE.test(localSha) && ![localRef, remoteRef].some((ref) => ref.startsWith("refs/tags/")));
  if (!branches.length) return 0;
  const head = io.git(["rev-parse", "HEAD"]).trim();
  const other = branches.find(([, localSha]) => localSha !== head);
  if (other) {
    io.err(`${other[0]} is not the commit checked out here, and the checks read the working tree. Check it out and push from there.`);
    return 1;
  }
  const { root, config } = configAt(io, values.config);
  let result;
  try {
    // origin/main
    const base = io.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    result = selectDiff(config, io.git, base, "HEAD", { mergeBase: true });
  } catch (error) {
    result = everything(config, `the default branch could not be found (${firstLine(error)}); run git remote set-head origin --auto`);
  }
  if (result.why) io.out(`Checking every suite: ${result.why}.`);
  const commands = [...new Set(result.selected.flatMap((name) => config.suites[name].prePush ?? []))];
  for (const command of commands) {
    const started = io.now();
    const { status, output } = io.exec(command, root);
    const seconds = ((io.now() - started) / 1000).toFixed(1);
    if (status !== 0) {
      io.err(output.trimEnd());
      io.err(`failed: ${command} (${seconds}s)`);
      io.err("Fix it and push again; never use --no-verify.");
      return 1;
    }
    io.out(`ok ${command} (${seconds}s)`);
  }
  return 0;
}

module.exports = { main };
