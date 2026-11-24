"use strict";
const { run } = require("../../lib/release.js");
const { gate } = require("../../lib/suites.js");

run(async () => {
  const env = process.env;
  const json = (name, text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} is not JSON: ${JSON.stringify(text)}`);
    }
  };
  const needs = json("needs", env.INPUT_NEEDS);
  const jobs = env.INPUT_JOBS?.trim() ? json("jobs", env.INPUT_JOBS) : undefined;
  let selected = env.INPUT_SELECTED;
  try {
    selected = JSON.parse(selected);
  } catch {
    // A router that failed leaves it empty; the gate says so.
  }
  for (const [id, { result }] of Object.entries(needs)) console.log(`${id}: ${result}`);
  const failures = gate({ needs, selected, jobs });
  for (const failure of failures) console.log(`::error::${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log("Every selected suite passed.");
});
