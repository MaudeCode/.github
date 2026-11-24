"use strict";
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { main } = require("../lib/cli.js");

const BIN = resolve(__dirname, "../bin/maudecode-ci.js");
const HOOK = resolve(__dirname, "../hooks/pre-push");
const ZERO = "0".repeat(40);
const HEAD = "a".repeat(40);

const FIXTURE = resolve(__dirname, "fixtures");
const config = require("./fixtures/.github/ci-suites.json");

/** A repository in a temporary directory with the suites file, removed when the test ends. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "maudecode-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/ci-suites.json"), JSON.stringify(config));
  return { root, git };
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test("maudecode-ci suites prints one line per suite, counting a rename under both paths, and --explain names each path's rule", (t) => {
  const { root, git } = repository(t);
  write(root, { "web/a.ts": "a\n", "cli/b.ts": "b\n" });
  git("add", ".");
  git("commit", "-qm", "base");
  git("mv", "web/a.ts", "cli/a.ts");
  git("commit", "-qm", "move");
  const ran = spawnSync(process.execPath, [BIN, "suites", "--base", "HEAD~1", "--explain"], { cwd: root, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, ["web=true", "cli=true", "docs=false", "# cli/a.ts: rules[1] (cli/**) -> cli", "# web/a.ts: rules[0] (web/**) -> web", ""].join("\n"));
});

/** The pre-push hook's world: a git that answers the hook's questions, and a runner that records each command. */
function prePush({ stdin, paths = ["web/a.ts"], failing = [], defaultBranch = "origin/main" }) {
  const [ran, out, err] = [[], [], []];
  const git = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return `${HEAD}\n`;
    if (key === "rev-parse --show-toplevel") return `${FIXTURE}\n`;
    if (key === "symbolic-ref --short refs/remotes/origin/HEAD" && defaultBranch) return `${defaultBranch}\n`;
    if (key === `diff --name-only --no-renames -z --end-of-options ${defaultBranch}...HEAD --`) return paths.map((path) => `${path}\0`).join("");
    throw Object.assign(new Error(`git ${key}`), { stderr: "fatal: no such ref\n" });
  };
  const exec = (command, cwd) => {
    ran.push(command);
    assert.equal(cwd, FIXTURE);
    return failing.includes(command) ? { status: 1, output: `${command}: 2 errors\n` } : { status: 0, output: "" };
  };
  let clock = 0;
  const status = main(["pre-push", "origin", "git@example.com:o/r.git"], { git, exec, stdin: () => stdin, out: (line) => out.push(line), err: (line) => err.push(line), now: () => (clock += 1500) });
  return { status, ran, out, err };
}

const branch = `refs/heads/topic ${HEAD} refs/heads/topic ${ZERO}\n`;

test("the pre-push hook skips tags and deletions", () => {
  for (const stdin of [`refs/tags/v1.0.0 ${"b".repeat(40)} refs/tags/v1.0.0 ${ZERO}\n`, `(delete) ${ZERO} refs/heads/old ${"c".repeat(40)}\n`, ""]) {
    const result = prePush({ stdin });
    assert.deepEqual([result.status, result.ran], [0, []], stdin);
  }
});

test("the pre-push hook refuses a branch that is not the commit checked out", () => {
  const result = prePush({ stdin: `refs/heads/other ${"b".repeat(40)} refs/heads/other ${ZERO}\n${branch}` });
  assert.equal(result.status, 1);
  assert.deepEqual(result.ran, []);
  assert.match(result.err.join("\n"), /refs\/heads\/other is not the commit checked out here/);
});

test("the pre-push hook runs the selected suites' commands in order, each once", () => {
  const result = prePush({ stdin: branch, paths: ["cli/x.ts", "web/a.ts", "README.md"] });
  assert.equal(result.status, 0, result.err.join("\n"));
  assert.deepEqual(result.ran, ["lint web", "typecheck", "lint cli"]);
  assert.deepEqual(result.out, ["ok lint web (1.5s)", "ok typecheck (1.5s)", "ok lint cli (1.5s)"]);
  assert.deepEqual(prePush({ stdin: branch, paths: ["README.md"] }).ran, []);
});

test("the pre-push hook stops at the first failure with its output and exits 1", () => {
  const result = prePush({ stdin: branch, failing: ["lint web"] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.ran, ["lint web"]);
  assert.deepEqual(result.err, ["lint web: 2 errors", "failed: lint web (1.5s)", "Fix it and push again; never use --no-verify."]);
});

test("the pre-push hook runs every suite's commands when it cannot select", () => {
  const result = prePush({ stdin: branch, defaultBranch: null });
  assert.equal(result.status, 0, result.err.join("\n"));
  assert.deepEqual(result.ran, ["lint web", "typecheck", "lint cli"]);
  assert.match(result.out[0], /^Checking every suite: the default branch could not be found/);
});

test("hooks/pre-push runs the installed command, and fails with the install command without it", (t) => {
  const { root } = repository(t);
  const run = () => spawnSync("sh", [HOOK, "origin", "url"], { cwd: root, encoding: "utf8", input: branch });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /maudecode-ci is not installed\. Install the dev dependencies with: pnpm install/);
  write(root, { "node_modules/.bin/maudecode-ci": '#!/bin/sh\necho "$@"\ncat\nexit 3\n' });
  chmodSync(join(root, "node_modules/.bin/maudecode-ci"), 0o755);
  const installed = run();
  assert.equal(installed.status, 3);
  assert.equal(installed.stdout, `pre-push origin url\n${branch}`);
});
