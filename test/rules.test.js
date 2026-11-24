"use strict";
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { main } = require("../lib/cli.js");

const PACKAGE = resolve(__dirname, "..");

/** A tree in a temporary directory holding `files` (path -> text), removed when the test ends. */
function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "maudecode-ci-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof text === "string" ? text : JSON.stringify(text, null, 2) + "\n");
  }
  return root;
}

/** Run `maudecode-ci rules --config ci/rules.json` in `root`. `hits` are the per-instance lines of a failure. */
function run(root, ...args) {
  const [out, err] = [[], []];
  const status = main(["rules", "--config", "ci/rules.json", ...args], { cwd: root, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { status, out, err, stderr: err.join("\n"), hits: err.filter((line) => line.startsWith("  ")).map((line) => line.trim()) };
}

const baselineOf = (root) => JSON.parse(readFileSync(join(root, "ci/rules-baseline.json"), "utf8"));

const CONFIG = {
  root: "..",
  roots: ["src", "vendor"],
  filePattern: "\\.ts$",
  excludeFilePattern: "^vendor/",
  baseline: "ci/rules-baseline.json",
  rules: {
    sleep: { paths: [""], excludeFilePattern: "\\.helper\\.ts$", patterns: ["\\bsleep\\("], message: "wait on the event" },
    wait: { paths: ["src/"], patterns: ["\\bwait\\("], nearby: { lines: 1, pattern: "\\bpage\\b" }, message: "wait for the page" },
    retry: { paths: [""], patterns: ["\\bretry\\("], blankPattern: "/\\* allowed \\*/[\\s\\S]*?/\\* end \\*/", message: "fix the cause" },
  },
};

test("a new instance fails with its file, its line in the original file, its rule and its message", (t) => {
  const root = tree(t, {
    "ci/rules.json": CONFIG,
    // The blanked block spans lines 1-3, so the hits after it keep their own line numbers.
    "src/a.ts": ["/* allowed */", "retry()", "/* end */", "sleep(1)", "wait()", "", "page", "wait()", "retry()"].join("\n"),
    "src/b.helper.ts": "sleep(1)\n",
    "vendor/c.ts": "sleep(1)\n",
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.deepEqual(result.hits, ["src/a.ts:9 retry: fix the cause", "src/a.ts:4 sleep: wait on the event", "src/a.ts:8 wait: wait for the page"]);
});

test("the baseline allows its count, fails one more, and --update lowers it but never raises it", (t) => {
  const files = { "ci/rules.json": CONFIG, "src/a.ts": "sleep(1)\nsleep(2)\n" };
  const at = tree(t, { ...files, "ci/rules-baseline.json": { counts: { sleep: { "src/a.ts": 2 } }, exceptions: [] } });
  assert.equal(run(at).status, 0);

  const above = run(tree(t, { ...files, "ci/rules-baseline.json": { counts: { sleep: { "src/a.ts": 1 } }, exceptions: [] } }));
  assert.equal(above.status, 1);
  assert.deepEqual(above.hits, ["src/a.ts:1 sleep: wait on the event", "src/a.ts:2 sleep: wait on the event"]);

  const below = tree(t, { ...files, "ci/rules-baseline.json": { counts: { sleep: { "src/a.ts": 3, "src/gone.ts": 1 } }, exceptions: [] } });
  assert.match(run(below).stderr, /src\/a\.ts: 2 sleep, below the baseline's 3; run maudecode-ci rules --config ci\/rules.json --update/);
  assert.equal(run(below, "--update").status, 0);
  assert.deepEqual(baselineOf(below), { counts: { sleep: { "src/a.ts": 2 } }, exceptions: [] });
  assert.equal(run(below).status, 0);

  writeFileSync(join(below, "src/a.ts"), "sleep(1)\nsleep(2)\nsleep(3)\nretry()\n");
  const raised = run(below, "--update");
  assert.equal(raised.status, 1);
  assert.deepEqual(raised.err.slice(1), [" - retry src/a.ts", " - sleep src/a.ts"]);
  assert.deepEqual(baselineOf(below), { counts: { sleep: { "src/a.ts": 2 } }, exceptions: [] });
});

test("an exceptions entry needs a reason", (t) => {
  for (const reason of [" ", undefined]) {
    const exception = { rule: "sleep", file: "src/a.ts", count: 1, reason };
    const result = run(tree(t, { "ci/rules.json": CONFIG, "src/a.ts": "sleep(1)\n", "ci/rules-baseline.json": { counts: {}, exceptions: [exception] } }));
    assert.equal(result.status, 1, String(reason));
    assert.match(result.stderr, /exceptions\[0\] \(sleep src\/a\.ts\): reason must be a non-empty sentence/);
  }
});

test("extends loads the parent's rules first, and a local rule with the same id replaces the parent's", (t) => {
  const { rules, ...local } = CONFIG;
  const root = tree(t, {
    "ci/parent.json": { rules },
    "ci/rules.json": { ...local, extends: "./parent.json", rules: { sleep: { paths: [""], patterns: ["\\bnap\\("], message: "the local rule" } } },
    "src/a.ts": "sleep(1)\nnap(1)\nretry()\n",
  });
  assert.deepEqual(run(root).hits, ["src/a.ts:3 retry: fix the cause", "src/a.ts:2 sleep: the local rule"]);
});

/** A repository that installed this package and extends its base test rules by package path. */
function adopter(t, files) {
  const root = tree(t, {
    "ci/rules.json": {
      extends: "@maudecode/ci/rules/test-rules.base.json",
      root: "..",
      roots: ["App", "web", "tests"],
      filePattern: "\\.(?:swift|ts|py)$",
      baseline: "ci/rules-baseline.json",
    },
    ...files,
  });
  mkdirSync(join(root, "node_modules/@maudecode"), { recursive: true });
  symlinkSync(PACKAGE, join(root, "node_modules/@maudecode/ci"), "dir");
  return root;
}

const LANGUAGES = [
  {
    file: "App/Tests/WaitTests.swift",
    text: ["func testWaits() async throws {", "  try await Task.sleep(nanoseconds: 1_000)", "  XCTAssertLessThan(Date().timeIntervalSince(start), 1)", "}"],
    hits: { "clock-sleep": 2, "clock-elapsed": 3 },
  },
  {
    file: "web/src/wait.test.ts",
    text: [
      // A call split across lines counts once, on its first line.
      "test.describe.configure({",
      "  retries: 2,",
      "})",
      "vi.spyOn(Date, 'now').mockReturnValue(0)",
      "await page.waitForTimeout(500)",
      "expect(Date.now() - started).toBeLessThan(100)",
    ],
    hits: { retry: 1, "unheld-clock": 4, "clock-sleep": 5, "clock-elapsed": 6 },
  },
  { file: "web/playwright.config.ts", text: ["export default { retries: process.env.CI ? 2 : 0 }"], hits: { "retry-config": 1 } },
  {
    file: "tests/test_wait.py",
    text: ["@pytest.mark.flaky", "def test_wait():", "    time.sleep(0.1)", "    assert time.time() - started < 1"],
    hits: { retry: 1, "clock-sleep": 3, "clock-elapsed": 4 },
  },
];

test("the base test rules fail each language's violations with each rule's message", (t) => {
  for (const { file, text, hits } of LANGUAGES) {
    const result = run(adopter(t, { [file]: text.join("\n") + "\n" }));
    assert.equal(result.status, 1, file);
    const { rules } = require("../rules/test-rules.base.json");
    const expected = Object.entries(hits).map(([rule, line]) => `${file}:${line} ${rule}: ${rules[rule].message}`);
    assert.deepEqual(result.hits.toSorted(), expected.toSorted(), file);
  }
});

test("the base test rules pass clean tests in each language", (t) => {
  const root = adopter(t, {
    "App/Tests/WaitTests.swift": "func testWaits() async throws {\n  await fulfillment(of: [loaded], timeout: 10)\n}\n",
    "web/src/wait.test.ts": "vi.useFakeTimers({ now: 0 })\nsetTimeout(resolve, 0)\nawait expect(page.getByRole('row')).toHaveCount(3)\n",
    "web/playwright.config.ts": "export default { retries: 0 }\n",
    "tests/test_wait.py": "async def test_wait():\n    await asyncio.sleep(0)\n    assert calls == 1\n",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.out, ["maudecode-ci rules: 0 counted instance(s), none above the baseline"]);
});
