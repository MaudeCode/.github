#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { main } = require("../lib/cli.js");
const { gitIn } = require("../lib/suites.js");

process.exitCode = main(process.argv.slice(2), {
  git: gitIn(process.cwd()),
  // One stream, so a failure's output reads in the order it was written.
  exec: (command, cwd) => {
    const ran = spawnSync("sh", ["-c", `exec 2>&1\n${command}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
    return { status: ran.status ?? 1, output: ran.error ? ran.error.message : ran.stdout };
  },
  stdin: () => readFileSync(0, "utf8"),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  now: () => performance.now(),
});
