"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const test = require("node:test");

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`scribe exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `could not parse scribe output: ${(error).message}\n${stdout}`,
          ),
        );
      }
    });
  });
}

test("parallel captures serialize journal writes and deduplicate identical retries", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scribe-concurrency-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const workspace = join(dir, "journal");
  const env = {
    SCRIBE_CONFIG: join(dir, "config.json"),
    SCRIBE_WORKSPACE: workspace,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
    GIT_AUTHOR_NAME: "Scribe Test",
    GIT_AUTHOR_EMAIL: "scribe@example.test",
    GIT_COMMITTER_NAME: "Scribe Test",
    GIT_COMMITTER_EMAIL: "scribe@example.test",
  };

  const init = await runCliAsync(
    ["init", "--workspace", workspace, "--no-git", "--json"],
    env,
  );
  assert.equal(init.ok, true);

  const uniqueCaptures = Array.from({ length: 10 }, (_, index) =>
    runCliAsync(
      [
        "capture",
        "--date",
        "2026-11-17",
        "--title",
        `Concurrent entry ${index}`,
        "--category",
        "finding",
        "--body",
        `Body for concurrent entry ${index}.`,
        "--json",
      ],
      env,
    ),
  );
  const uniqueResults = await Promise.all(uniqueCaptures);
  assert.equal(uniqueResults.length, 10);
  assert.ok(uniqueResults.every((result) => result.ok));

  const duplicateCaptures = Array.from({ length: 8 }, () =>
    runCliAsync(
      [
        "capture",
        "--date",
        "2026-11-17",
        "--title",
        "Same concurrent retry",
        "--category",
        "decision",
        "--body",
        "This identical entry should be written once.",
        "--json",
      ],
      env,
    ),
  );
  const duplicateResults = await Promise.all(duplicateCaptures);

  assert.equal(
    duplicateResults.filter((result) => result.deduplicated === true).length,
    7,
  );
  assert.equal(
    duplicateResults.filter((result) => result.deduplicated !== true).length,
    1,
  );

  const read = await runCliAsync(["read", "--all", "--json"], env);
  assert.equal(read.entries.length, 11);
  assert.equal(
    read.entries.filter((entry) => entry.title === "Same concurrent retry")
      .length,
    1,
  );
  assert.equal(
    new Set(read.entries.map((entry) => entry.title)).size,
    read.entries.length,
  );
});
