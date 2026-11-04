"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_AGENT,
  DEFAULT_WORKSPACE,
  defaultConfigPath,
  loadConfig,
  resolvePath,
  saveConfig,
  tildifyPath,
} = require("../dist/config.js");
const { parseJson, runCli, tempDir } = require("./helpers");

test("loadConfig falls back to defaults", (t) => {
  const dir = tempDir(t);
  const config = loadConfig({ configPath: `${dir}/missing.json` });

  assert.equal(config.workspace, DEFAULT_WORKSPACE);
  assert.equal(config.agent, DEFAULT_AGENT);
  assert.equal(config.autoCommit, true);
  assert.equal(config.autoPush, true);
  assert.equal(config.remote, undefined);
});

test("saveConfig round-trips through loadConfig", (t) => {
  const dir = tempDir(t);
  const configPath = `${dir}/nested/config.json`;
  const workspace = `${dir}/journal`;

  saveConfig(
    {
      workspace,
      remote: "origin",
      agent: "OpenCode",
      autoCommit: false,
      autoPush: false,
    },
    configPath,
  );

  const loaded = loadConfig({ configPath });
  assert.deepEqual(loaded, {
    workspace,
    remote: "origin",
    agent: "OpenCode",
    autoCommit: false,
    autoPush: false,
  });
});

test("environment overrides file config", (t) => {
  const dir = tempDir(t);
  const configPath = `${dir}/config.json`;
  saveConfig(
    {
      workspace: `${dir}/file-journal`,
      agent: "file-agent",
      autoCommit: true,
      autoPush: true,
    },
    configPath,
  );

  const previous = { ...process.env };
  try {
    process.env.SCRIBE_WORKSPACE = `${dir}/env-journal`;
    process.env.SCRIBE_AGENT = "env-agent";
    process.env.SCRIBE_AUTO_COMMIT = "false";
    process.env.SCRIBE_AUTO_PUSH = "no";

    const config = loadConfig({ configPath });
    assert.equal(config.workspace, `${dir}/env-journal`);
    assert.equal(config.agent, "env-agent");
    assert.equal(config.autoCommit, false);
    assert.equal(config.autoPush, false);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test("path helpers expand and tildify home", () => {
  assert.equal(tildifyPath(resolvePath("~")), "~");
  assert.equal(tildifyPath(resolvePath("~/notes")), "~/notes");

  const relative = resolvePath("relative-dir", "/tmp/base");
  assert.equal(relative, "/tmp/base/relative-dir");
});

test("cli config reports resolved config as JSON", (t) => {
  const dir = tempDir(t);
  const configPath = `${dir}/config.json`;

  const init = runCli(
    ["init", "--workspace", `${dir}/journal`, "--no-git", "--json"],
    { env: { SCRIBE_CONFIG: configPath } },
  );
  assert.equal(init.status, 0, init.stderr);

  const result = runCli(["config", "--json"], {
    env: { SCRIBE_CONFIG: configPath },
  });
  assert.equal(result.status, 0, result.stderr);

  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.configPath, configPath);
  assert.equal(output.config.workspace, `${dir}/journal`);
});

test("defaultConfigPath honors XDG_CONFIG_HOME", (t) => {
  const dir = tempDir(t);
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = dir;
    assert.equal(defaultConfigPath(), `${dir}/scribe/config.json`);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});
