"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compareVersions, createTag, parseVersion, refusal, versionTags } = require("../lib/release.js");

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const release = { event: "workflow_dispatch", ref: "refs/heads/main", defaultBranch: "main", runSha: SHA, sha: SHA, tag: "v1.3.0", tags: ["v1.2.0", "v1.2.1", "nightly", "v9"] };

test("a release is a dispatch on the default branch, of the expected commit, under an unused later version", () => {
  assert.equal(refusal(release), null);
  assert.equal(refusal({ ...release, tags: [] }), null);
  assert.equal(refusal({ ...release, tag: "v1.3.0-rc.1" }), null);
  assert.equal(refusal({ ...release, sha: "" }), null, "no sha releases the commit the run is on");
  for (const [change, reason] of [
    [{ event: "push" }, /started by dispatching/],
    [{ ref: "refs/heads/feature" }, /runs on main/],
    [{ ref: "refs/tags/v1.3.0" }, /runs on main/],
    [{ tag: "1.3.0" }, /not a version tag/],
    [{ tag: "v1.3" }, /not a version tag/],
    [{ tag: "v1.3.0+build" }, /not a version tag/],
    [{ sha: "abc123" }, /full commit SHA/],
    [{ sha: OTHER }, /main is at aaaaaaa, not the bbbbbbb/],
    [{ tag: "v1.2.1" }, /already exists/],
    [{ tag: "v1.2.0-rc.1" }, /does not come after v1\.2\.1/],
    [{ tag: "v1.1.9" }, /does not come after v1\.2\.1/],
  ]) assert.match(refusal({ ...release, ...change }), reason, JSON.stringify(change));
});

test("versions order by Semantic Versioning precedence", () => {
  const ordered = ["v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0", "v1.0.1", "v1.10.0", "v2.0.0"];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(parseVersion(ordered[i - 1]), parseVersion(ordered[i])) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(parseVersion("v01.0.0"), null);
  assert.equal(parseVersion("v1.0.0-01"), null);
});

/** A repository's tags, behind the three endpoints the actions use. */
function repository(tags = {}) {
  const objects = {};
  const calls = [];
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/git/matching-refs/tags/v")) {
      const names = Object.keys(tags).filter((name) => name.startsWith("v"));
      const page = path.includes("page=2") ? names.slice(1) : names.slice(0, 1);
      return { status: 200, data: page.map((name) => ({ ref: `refs/tags/${name}` })), next: path.includes("page=2") || names.length < 2 ? undefined : `${path}&page=2` };
    }
    if (method === "GET" && path.startsWith("/git/ref/tags/")) {
      const tag = tags[decodeURIComponent(path.slice("/git/ref/tags/".length))];
      return tag ? { status: 200, data: { object: tag } } : { status: 404, data: { message: "Not Found" } };
    }
    if (method === "GET" && path.startsWith("/git/tags/")) return { status: 200, data: { object: { sha: objects[path.slice("/git/tags/".length)] } } };
    if (method === "POST" && path === "/git/tags") {
      const sha = `object-${Object.keys(objects).length}`;
      objects[sha] = body.object;
      return { status: 201, data: { sha } };
    }
    if (method === "POST" && path === "/git/refs") {
      const name = body.ref.replace("refs/tags/", "");
      if (tags[name]) return { status: 422, data: { message: "Reference already exists" } };
      tags[name] = { type: "tag", sha: body.sha };
      return { status: 201, data: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, tags, calls };
}

test("every page of version tags is read", async () => {
  const { api } = repository({ "v1.0.0": {}, "v1.1.0": {}, "v1.2.0": {} });
  assert.deepEqual(await versionTags(api), ["v1.0.0", "v1.1.0", "v1.2.0"]);
});

test("the tag is created once at the released commit; a re-run succeeds and another commit is refused", async () => {
  const repo = repository();
  assert.equal(await createTag(repo.api, { tag: "v1.3.0", sha: SHA, message: "demo 1.3.0" }), "created");
  assert.equal(repo.tags["v1.3.0"].type, "tag");
  const writes = () => repo.calls.filter((call) => call.startsWith("POST")).length;
  const before = writes();
  assert.equal(await createTag(repo.api, { tag: "v1.3.0", sha: SHA, message: "demo 1.3.0" }), "exists");
  assert.equal(writes(), before, "a re-run writes nothing");
  await assert.rejects(createTag(repo.api, { tag: "v1.3.0", sha: OTHER, message: "demo 1.3.0" }), /already names aaaaaaa, not bbbbbbb/);
  // A lightweight tag someone pushed by hand counts the same way.
  const manual = repository({ "v2.0.0": { type: "commit", sha: SHA } });
  assert.equal(await createTag(manual.api, { tag: "v2.0.0", sha: SHA, message: "demo 2.0.0" }), "exists");
});
