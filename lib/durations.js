"use strict";
// maudecode-ci test-durations: fail a test run whose tests break the per-test run-time budget (CI.md, "Test checks").
// Ported from Talaria's scripts/check-test-durations.py.
//
// Reads JUnit XML (vitest, Playwright, pytest), `xcrun xcresulttool get test-results tests` JSON (*.json) and XCTest
// logs (`swift test` output, *.log). A test over `budgetSeconds` (30 by default) fails unless the config's `overBudget`
// lists it with its ticket. A listed key is `suite::test`; it matches a JUnit case whose name ends with the test's
// title after its describe blocks, and every parameter of a parametrized pytest case.
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { parseArgs } = require("node:util");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (whole, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name] ?? whole),
  );

// ponytail: scans `<testcase ...>` start tags with a regex, so a testcase inside a comment or CDATA counts too; use an
// XML parser if a report ever puts one there.
function* junit(text) {
  for (const [, attributes] of text.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const values = {};
    for (const [, key, double, single] of attributes.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) values[key] = unescape(double ?? single);
    yield [values.classname ?? "", values.name ?? "", Number(values.time || 0)];
  }
}

function* xcresult(text) {
  function* visit(node, suite) {
    if (node.nodeType === "Test Case" && typeof node.durationInSeconds === "number") yield [suite, node.name.replace(/\(\)$/, ""), node.durationInSeconds];
    for (const child of node.children ?? []) yield* visit(child, node.nodeType === "Test Suite" ? node.name : suite);
  }
  for (const root of JSON.parse(text).testNodes) yield* visit(root, "");
}

const XCTEST_LOG = /Test Case '-\[\w+\.(\w+) (\w+)\]' (?:passed|failed|skipped) \((\d+(?:\.\d+)?) seconds\)/g;

function* xctestLog(text) {
  for (const [, suite, name, seconds] of text.matchAll(XCTEST_LOG)) yield [suite, name, Number(seconds)];
}

/** `[suite, name, seconds]` for every test case in one report, read by its extension. */
function cases(path, text) {
  if (path.endsWith(".log")) return xctestLog(text);
  return path.endsWith(".json") ? xcresult(text) : junit(text);
}

function listed(suite, name, overBudget) {
  const bare = name.replace(/\[.*\]$/, "");
  return Object.keys(overBudget).some((key) => {
    const at = key.indexOf("::");
    const [listedSuite, title] = at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 2)];
    return listedSuite === suite && (title === name || title === bare || name.endsWith(` > ${title}`) || name.endsWith(` › ${title}`));
  });
}

/**
 * `maudecode-ci test-durations --config <file> REPORT...`. Paths are relative to cwd.
 * @param {string[]} argv
 * @param {{ cwd: string, out: (line: string) => void, err: (line: string) => void }} io
 */
function testDurations(argv, io) {
  const { values, positionals: paths } = parseArgs({ args: argv, options: { config: { type: "string" } }, allowPositionals: true });
  if (!values.config) throw new Error("maudecode-ci test-durations: --config <path> is required");
  const budget = JSON.parse(readFileSync(resolve(io.cwd, values.config), "utf8"));
  const limit = budget.budgetSeconds ?? 30;
  const overBudget = budget.overBudget ?? {};
  const unexplained = Object.entries(overBudget).filter(([, reason]) => typeof reason !== "string" || !reason.trim());
  if (unexplained.length) {
    for (const [key] of unexplained) io.err(`maudecode-ci test-durations: overBudget[${JSON.stringify(key)}] must name its ticket or reason`);
    return 1;
  }
  if (!paths.length) {
    io.err("maudecode-ci test-durations: no test report given");
    return 1;
  }
  let measured = 0;
  const failures = [];
  for (const path of paths) {
    for (const [suite, name, seconds] of cases(path, readFileSync(resolve(io.cwd, path), "utf8"))) {
      measured += 1;
      if (seconds > limit && !listed(suite, name, overBudget)) failures.push(`  ${suite}::${name} took ${seconds.toFixed(1)} s`);
    }
  }
  if (!measured) {
    io.err(`maudecode-ci test-durations: no test cases in ${paths.join(", ")}`);
    return 1;
  }
  if (failures.length) {
    io.err(
      `maudecode-ci test-durations: ${failures.length} test(s) over the ${limit} s per-test budget. Split the test or prove` +
        " it at a cheaper layer (test-audit rules heavy and oversized, docs/testing.md):",
    );
    for (const failure of failures) io.err(failure);
    return 1;
  }
  io.out(`maudecode-ci test-durations: ${measured} test case(s), none over the ${limit} s budget outside the listed ones`);
  return 0;
}

module.exports = { testDurations };
