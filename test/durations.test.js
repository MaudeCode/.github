"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { main } = require("../lib/cli.js");

const JUNIT = (extra = "") => `<?xml version="1.0"?>
<testsuites><testsuite name="s">
<testcase classname="src/a.test.ts" name="outer &gt; slow and listed" time="45"/>
<testcase classname="tests.test_x" name="test_param[mode]" time="40"></testcase>
<testcase classname='session.spec.ts' name='group › fast' time='2'/>
${extra}
</testsuite></testsuites>`;

const XCRESULT = (seconds) =>
  JSON.stringify({
    testNodes: [
      {
        nodeType: "Test Plan",
        name: "Plan",
        children: [
          {
            nodeType: "Unit test bundle",
            name: "AppTests",
            children: [
              {
                nodeType: "Test Suite",
                name: "ChatTests",
                children: [
                  { nodeType: "Test Case", name: "testListed()", durationInSeconds: 90 },
                  { nodeType: "Test Case", name: "testFast()", durationInSeconds: 1 },
                  { nodeType: "Test Case", name: "testNew()", durationInSeconds: seconds },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

const XCTEST_LOG = (seconds) => `Test Case '-[AppKitTests.ChatTests testListed]' passed (90.000 seconds).
Test Case '-[AppKitTests.ChatTests testNew]' started.
Test Case '-[AppKitTests.ChatTests testNew]' passed (${seconds} seconds).
`;

const OVER_BUDGET = {
  "src/a.test.ts::slow and listed": "DOTGH-2: fixture",
  "tests.test_x::test_param": "DOTGH-2: fixture",
  "ChatTests::testListed": "DOTGH-2: fixture",
};

/** Run `maudecode-ci test-durations` in a directory holding `files` and the budget config. */
function run(t, files, { budget = { overBudget: OVER_BUDGET }, reports = Object.keys(files) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "maudecode-ci-durations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "test-durations.json"), JSON.stringify(budget));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const [out, err] = [[], []];
  const status = main(["test-durations", "--config", "test-durations.json", ...reports], { cwd: dir, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { status, out, err };
}

test("each report format fails an unlisted test over the default 30 s budget by name and passes the listed ones", (t) => {
  for (const [name, within, over, failing] of [
    ["junit.xml", JUNIT(), JUNIT('<testcase classname="src/b.test.ts" name="new" time="31"/>'), "src/b.test.ts::new took 31.0 s"],
    ["tests.json", XCRESULT(29), XCRESULT(31), "ChatTests::testNew took 31.0 s"],
    ["attempt-1.log", XCTEST_LOG("29.000"), XCTEST_LOG("31.000"), "ChatTests::testNew took 31.0 s"],
  ]) {
    assert.equal(run(t, { [name]: within }).status, 0, name);
    const result = run(t, { [name]: over });
    assert.equal(result.status, 1, name);
    assert.match(result.err[0], /1 test\(s\) over the 30 s per-test budget/, name);
    assert.deepEqual(result.err.slice(1), [`  ${failing}`], name);
  }
});

test("a listed key matches a parametrized case and a title inside describe blocks", (t) => {
  const unlisted = run(t, { "junit.xml": JUNIT() }, { budget: { budgetSeconds: 30, overBudget: {} } });
  assert.deepEqual(unlisted.err.slice(1), ["  src/a.test.ts::outer > slow and listed took 45.0 s", "  tests.test_x::test_param[mode] took 40.0 s"]);
  assert.equal(run(t, { "junit.xml": JUNIT() }).status, 0);
});

test("no report, or a report with no test cases, fails", (t) => {
  assert.deepEqual(run(t, {}).err, ["maudecode-ci test-durations: no test report given"]);
  assert.deepEqual(run(t, { "junit.xml": "<testsuites/>" }).err, ["maudecode-ci test-durations: no test cases in junit.xml"]);
});
