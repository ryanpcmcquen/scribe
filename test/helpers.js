"use strict";

const { spawnSync } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

const SCRIBE_ENV_KEYS = [
  "SCRIBE_CONFIG",
  "SCRIBE_WORKSPACE",
  "SCRIBE_REMOTE",
  "SCRIBE_AGENT",
  "SCRIBE_AUTO_COMMIT",
  "SCRIBE_AUTO_PUSH",
];

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "scribe-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of SCRIBE_ENV_KEYS) delete env[key];

  return {
    ...env,
    GIT_AUTHOR_NAME: "Scribe Test",
    GIT_AUTHOR_EMAIL: "scribe@example.test",
    GIT_COMMITTER_NAME: "Scribe Test",
    GIT_COMMITTER_EMAIL: "scribe@example.test",
    ...overrides,
  };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd,
    env: cleanEnv(options.env),
  });
}

function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse CLI JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

module.exports = { cleanEnv, parseJson, runCli, tempDir };
