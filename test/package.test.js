"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const test = require("node:test");

const ROOT = join(__dirname, "..");

test("packed npm artifact includes agent skills and can install them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scribe-pack-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pack = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(pack.status, 0, pack.stderr);

  const parsedPack = JSON.parse(pack.stdout);
  const packInfo = Array.isArray(parsedPack)
    ? parsedPack[0]
    : parsedPack.scribe;
  const artifact = join(dir, packInfo.filename);
  assert.ok(existsSync(artifact));

  const archiveList = spawnSync("tar", ["-tzf", artifact], {
    encoding: "utf8",
  });
  assert.equal(archiveList.status, 0, archiveList.stderr);
  for (const agent of [
    "opencode",
    "claude-code",
    "codex",
    "cline",
    "antigravity",
  ]) {
    assert.match(
      archiveList.stdout,
      new RegExp(`package/skills/${agent}/scribe-capture\\.md`),
    );
  }

  const extract = spawnSync("tar", ["-xzf", artifact, "-C", dir], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);

  const packageDir = join(dir, "package");
  const hooks = require(join(packageDir, "dist", "hooks", "index.js"));
  const installHome = join(dir, "installation", "home");
  const configHome = join(dir, "installation", "config");
  const results = hooks.installAgentSkills({ homeDir: installHome, configHome });

  assert.equal(results.length, 5);
  for (const result of results) {
    assert.ok(existsSync(result.skillPath));
  }

  const version = spawnSync(
    process.execPath,
    [join(packageDir, "dist", "cli.js"), "--version"],
    { encoding: "utf8" },
  );
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, new RegExp(`scribe ${packInfo.version}`));
  assert.deepEqual(readdirSync(join(packageDir, "skills")).sort(), [
    "antigravity",
    "claude-code",
    "cline",
    "codex",
    "opencode",
  ]);
});
