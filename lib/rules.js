"use strict";
// maudecode-ci rules: a pattern scanner with a lowering-only baseline, for UI rules and test rules (CI.md, "Test checks").
// Ported from Talaria's scripts/check-ui-rules.mjs, adding `extends`.
const { existsSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { parseArgs } = require("node:util");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

/**
 * Read a config and its `extends` chain. A parent's rules load first, and a local rule with the same id replaces it;
 * nothing else is inherited. `extends` is a path relative to the config, or a package path such as
 * `@maudecode/ci/rules/test-rules.base.json`, resolved from the config's directory.
 */
function loadConfig(file, seen = []) {
  if (seen.includes(file)) throw new Error(`${file}: extends itself through ${seen.join(" -> ")}`);
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (config.extends === undefined) return config;
  if (typeof config.extends !== "string" || !config.extends) throw new Error(`${file}: extends must name one config file`);
  const from = dirname(file);
  const parentFile = config.extends.startsWith(".") || isAbsolute(config.extends) ? resolve(from, config.extends) : require.resolve(config.extends, { paths: [from] });
  const parent = loadConfig(parentFile, [...seen, file]);
  return { ...config, rules: { ...parent.rules, ...config.rules } };
}

/** Every matching instance, with paths relative to the configured root and original line numbers. */
function scan(root, config) {
  const hits = [];
  const filePattern = new RegExp(config.filePattern);
  const excluded = config.excludeFilePattern && new RegExp(config.excludeFilePattern);
  const rules = Object.entries(config.rules).map(([id, rule]) => [
    id,
    {
      ...rule,
      patterns: rule.patterns.map((pattern) => new RegExp(pattern, rule.multiline ? "gm" : "g")),
      excluded: rule.excludeFilePattern && new RegExp(rule.excludeFilePattern),
      blank: rule.blankPattern && new RegExp(rule.blankPattern, "g"),
      nearby: rule.nearby && { ...rule.nearby, pattern: new RegExp(rule.nearby.pattern) },
    },
  ]);
  const files = new Set(config.roots.flatMap((top) => (existsSync(join(root, top)) ? walk(join(root, top)) : [])));
  for (const path of [...files].sort()) {
    const file = relative(root, path).split(sep).join("/");
    if (!filePattern.test(file) || (excluded && excluded.test(file))) continue;
    const source = readFileSync(path, "utf8");
    for (const [id, rule] of rules) {
      if (
        !rule.paths.some((prefix) => file.startsWith(prefix)) ||
        rule.excludePaths?.some((prefix) => file.startsWith(prefix)) ||
        (rule.excluded && rule.excluded.test(file))
      )
        continue;
      // Blank allowed blocks without moving diagnostic line numbers.
      const text = rule.blank ? source.replace(rule.blank, (block) => block.replace(/[^\n]/g, " ")) : source;
      const lines = text.split("\n");
      const near = (i) => !rule.nearby || lines.slice(Math.max(0, i - rule.nearby.lines), i + rule.nearby.lines + 1).some((line) => rule.nearby.pattern.test(line));
      const count = (match, i) => near(i) && !rule.ignoreValues?.includes(match[1]) && hits.push({ rule: id, file, line: i + 1 });
      if (rule.multiline) {
        // A multiline rule matches the whole file, so a call split across lines still counts, on the line it starts.
        const found = rule.patterns.flatMap((pattern) => [...text.matchAll(pattern)]).sort((a, b) => a.index - b.index);
        for (const match of found) count(match, text.slice(0, match.index).split("\n").length - 1);
      } else {
        lines.forEach((line, i) => {
          for (const pattern of rule.patterns) for (const match of line.matchAll(pattern)) count(match, i);
        });
      }
    }
  }
  return hits;
}

const sortCounts = (counts) =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .filter((rule) => Object.keys(counts[rule]).length)
      .map((rule) => [rule, Object.fromEntries(Object.keys(counts[rule]).sort().map((file) => [file, counts[rule][file]]))]),
  );

/** `{ rule: { file: count } }`, keys sorted by rule then file, zero counts absent. */
function tally(hits) {
  const counts = {};
  for (const { rule, file } of hits) (counts[rule] ??= {})[file] = (counts[rule][file] ?? 0) + 1;
  return sortCounts(counts);
}

/** The baseline file's canonical text: rules then files sorted, two-space JSON, trailing newline. */
const serialize = (baseline) => JSON.stringify({ counts: sortCounts(baseline.counts ?? {}), exceptions: baseline.exceptions ?? [] }, null, 2) + "\n";

/** Problems with the hand-written `exceptions`: unknown rule, missing file, non-positive count or an empty reason. */
function exceptionErrors(baseline, rules) {
  return (baseline.exceptions ?? []).flatMap((e, i) => {
    const where = `exceptions[${i}] (${e?.rule ?? "?"} ${e?.file ?? "?"})`;
    const errors = [];
    if (!Object.hasOwn(rules, e?.rule)) errors.push(`${where}: unknown rule`);
    if (typeof e?.file !== "string" || !e.file) errors.push(`${where}: missing file`);
    if (!Number.isInteger(e?.count) || e.count < 1) errors.push(`${where}: count must be a positive integer`);
    if (typeof e?.reason !== "string" || !e.reason.trim()) errors.push(`${where}: reason must be a non-empty sentence`);
    return errors;
  });
}

/** Baseline count plus every exception's count for one rule and file. */
const allowance = (baseline, rule, file) =>
  (baseline.counts?.[rule]?.[file] ?? 0) +
  (baseline.exceptions ?? []).filter((e) => e.rule === rule && e.file === file).reduce((sum, e) => sum + (Number.isInteger(e.count) ? e.count : 0), 0);

/** Every rule and file named by the tree, the baseline or an exception. */
function keys(hits, baseline) {
  const seen = new Set([
    ...hits.map((h) => `${h.rule}\0${h.file}`),
    ...Object.entries(baseline.counts ?? {}).flatMap(([rule, files]) => Object.keys(files).map((file) => `${rule}\0${file}`)),
    ...(baseline.exceptions ?? []).map((e) => `${e.rule}\0${e.file}`),
  ]);
  return [...seen].sort().map((key) => key.split("\0"));
}

/** Compare the tree's hits with the baseline. Returns error lines; empty means pass. */
function check(hits, baseline, text, rules, update, name) {
  const errors = exceptionErrors(baseline, rules);
  const counts = tally(hits);
  for (const [rule, file] of keys(hits, baseline)) {
    const actual = counts[rule]?.[file] ?? 0;
    const allowed = allowance(baseline, rule, file);
    if (actual > allowed) {
      errors.push(`${file}: ${actual} ${rule} (allowed ${allowed}): ${rules[rule]?.message ?? "unknown rule"}`);
      for (const h of hits) if (h.rule === rule && h.file === file) errors.push(`  ${h.file}:${h.line} ${rule}: ${rules[rule].message}`);
    } else if (actual < allowed) {
      const exempt = allowed - (baseline.counts?.[rule]?.[file] ?? 0);
      errors.push(
        actual < exempt
          ? `${file}: ${actual} ${rule}, below its exceptions' ${exempt}; lower or remove that exceptions entry`
          : `${file}: ${actual} ${rule}, below the baseline's ${allowed}; run ${update}`,
      );
    }
  }
  if (!errors.length && text !== serialize(baseline)) errors.push(`${name} is not sorted and formatted; run ${update}`);
  return errors;
}

/**
 * The baseline `--update` writes: each count lowered to what the tree needs beyond its exceptions, zero entries
 * removed. Never raises a count; `refused` lists the files whose tree count exceeds the allowance.
 */
function lower(hits, baseline) {
  const counts = tally(hits);
  const next = {};
  const refused = [];
  for (const [rule, files] of Object.entries(baseline.counts ?? {})) {
    for (const [file, count] of Object.entries(files)) {
      const exempt = allowance(baseline, rule, file) - count;
      const needed = Math.min(count, Math.max(0, (counts[rule]?.[file] ?? 0) - exempt));
      if (needed) (next[rule] ??= {})[file] = needed;
    }
  }
  for (const [rule, file] of keys(hits, baseline)) if ((counts[rule]?.[file] ?? 0) > allowance(baseline, rule, file)) refused.push(`${rule} ${file}`);
  return { baseline: { counts: sortCounts(next), exceptions: baseline.exceptions ?? [] }, refused };
}

/**
 * `maudecode-ci rules --config <file> [--update]`. The config path is relative to cwd, its `root` to the config, and
 * its `baseline` to the root.
 * @param {string[]} argv
 * @param {{ cwd: string, out: (line: string) => void, err: (line: string) => void }} io
 */
function rules(argv, io) {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" }, update: { type: "boolean" } } });
  if (!values.config) throw new Error("maudecode-ci rules: --config <path> is required");
  const configPath = resolve(io.cwd, values.config);
  const config = loadConfig(configPath);
  const root = resolve(dirname(configPath), config.root ?? ".");
  const path = resolve(root, config.baseline);
  const update = `maudecode-ci rules --config ${values.config} --update`;
  const text = existsSync(path) ? readFileSync(path, "utf8") : serialize({});
  const baseline = JSON.parse(text);
  const hits = scan(root, config);
  if (values.update) {
    const { baseline: next, refused } = lower(hits, baseline);
    writeFileSync(path, serialize(next));
    if (refused.length) {
      io.err(`maudecode-ci rules --update: refused to raise ${refused.length} count(s); remove the new instances or add an exceptions entry with a reason`);
      for (const r of refused) io.err(" - " + r);
      return 1;
    }
    io.out("maudecode-ci rules --update: baseline lowered to the tree");
    return 0;
  }
  const errors = check(hits, baseline, text, config.rules, update, basename(config.baseline));
  if (errors.length) {
    io.err(`maudecode-ci rules: ${errors.length} problem(s) (${values.config})`);
    for (const e of errors) io.err(e.startsWith("  ") ? e : " - " + e);
    return 1;
  }
  io.out(`maudecode-ci rules: ${hits.length} counted instance(s), none above the baseline`);
  return 0;
}

module.exports = { rules };
