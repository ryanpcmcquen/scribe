"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  createOpenCodePlugin,
  SCRIBE_SYSTEM_DIRECTIVE,
} = require("../dist/plugins/opencode.js");
const { parseJson, runCli, tempDir } = require("./helpers");

const hasGit =
  spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function initGitProject(dir) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.name", "Test User"], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("scribe hook post-commit captures commits and deduplicates reruns", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const dir = tempDir(t);
  const journal = `${dir}/journal`;
  const repo = `${dir}/app`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: journal,
  };

  runCli(["init", "--workspace", journal, "--json"], { env });
  initGitProject(repo);
  writeFileSync(`${repo}/index.js`, "console.log('ok');\n");
  spawnSync("git", ["add", "index.js"], { cwd: repo, encoding: "utf8" });
  spawnSync(
    "git",
    ["commit", "-m", "fix: resolve startup race condition"],
    { cwd: repo, encoding: "utf8" },
  );

  const first = runCli(
    ["hook", "post-commit", "--repo", repo, "--agent", "OpenCode", "--json"],
    { env },
  );
  assert.equal(first.status, 0, first.stderr);
  const firstOut = parseJson(first);
  assert.equal(firstOut.ok, true);
  assert.equal(firstOut.skipped, false);
  assert.equal(firstOut.entry.category, "finding");
  assert.equal(firstOut.entry.title, "fix: resolve startup race condition");
  assert.match(firstOut.entry.body, /Commit `[0-9a-f]+` — Files: `index\.js`\./);

  const second = runCli(
    ["hook", "post-commit", "--repo", repo, "--agent", "OpenCode", "--json"],
    { env },
  );
  assert.equal(second.status, 0, second.stderr);
  const secondOut = parseJson(second);
  assert.equal(secondOut.skipped, true);
  assert.equal(secondOut.reason, "commit already captured");
});

test("scribe hook post-commit skips the Scribe journal repo itself", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const dir = tempDir(t);
  const journal = `${dir}/journal`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: journal,
  };

  runCli(["init", "--workspace", journal, "--json"], { env });

  const result = runCli(
    ["hook", "post-commit", "--repo", journal, "--json"],
    { env },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = parseJson(result);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /Scribe journal itself/);
});

test("scribe hook agent-stop captures stdin payload and deduplicates", (t) => {
  const dir = tempDir(t);
  const journal = `${dir}/journal`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: journal,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };

  const payload = JSON.stringify({
    title: "Decided to expose stdio MCP server",
    summary: "Added zero-dependency JSON-RPC 2.0 MCP server for all five CLI agents.",
    workspace: `${dir}/app`,
    agent: "Claude Code",
  });

  const first = runCli(["hook", "agent-stop", "--stdin", "--json"], {
    env,
    input: payload,
  });
  assert.equal(first.status, 0, first.stderr);
  const firstOut = parseJson(first);
  assert.equal(firstOut.skipped, false);
  assert.equal(firstOut.entry.category, "decision");

  const second = runCli(["hook", "agent-stop", "--stdin", "--json"], {
    env,
    input: payload,
  });
  assert.equal(second.status, 0, second.stderr);
  const secondOut = parseJson(second);
  assert.equal(secondOut.skipped, true);
});

test("scribe hooks install, status, and uninstall preserve existing post-commit hooks", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const dir = tempDir(t);
  const repo = `${dir}/app`;
  initGitProject(repo);

  const hookFile = `${repo}/.git/hooks/post-commit`;
  writeFileSync(hookFile, "#!/bin/sh\necho 'custom hook'\n");

  const install = parseJson(
    runCli(["hooks", "install", "--git", "--repo", repo, "--json"]),
  );
  assert.equal(install.gitHook.installed, true);
  assert.match(readFileSync(hookFile, "utf8"), /echo 'custom hook'/);
  assert.match(readFileSync(hookFile, "utf8"), /scribe hook post-commit/);

  const status = parseJson(
    runCli(["hooks", "status", "--repo", repo, "--json"]),
  );
  assert.equal(status.gitHook.installed, true);

  const uninstall = parseJson(
    runCli(["hooks", "uninstall", "--repo", repo, "--json"]),
  );
  assert.equal(uninstall.gitHook.removed, true);
  assert.ok(existsSync(hookFile));
  assert.match(readFileSync(hookFile, "utf8"), /echo 'custom hook'/);
  assert.doesNotMatch(readFileSync(hookFile, "utf8"), /scribe hook post-commit/);
});

test("createOpenCodePlugin registers tools and injects context directive", async (t) => {
  const dir = tempDir(t);
  const plugin = createOpenCodePlugin({
    workspace: `${dir}/journal`,
    autoCommit: false,
    autoPush: false,
  });

  const registeredTools = [];
  const sessionHooks = {};

  const cleanup = await plugin.setup({
    location: { directory: `${dir}/project` },
    tool: {
      async transform(cb) {
        cb({
          add(tool) {
            registeredTools.push(tool);
          },
        });
        return { async dispose() {} };
      },
    },
    session: {
      async hook(name, cb) {
        sessionHooks[name] = cb;
        return { async dispose() {} };
      },
    },
  });

  assert.equal(registeredTools.length, 4);
  const system = [{ type: "text", text: "Base instructions." }];
  await sessionHooks.context({ sessionID: "ses_1", system });
  await sessionHooks.context({ sessionID: "ses_1", system });
  assert.equal(system.length, 2);
  assert.equal(system[1].text, SCRIBE_SYSTEM_DIRECTIVE);

  const captureTool = registeredTools.find((tool) => tool.name === "scribe_capture");
  const res = await captureTool.execute({
    title: "Plugin tool capture",
    category: "work-log",
    body: "Recorded from OpenCode plugin tool.",
  });
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.title, "Plugin tool capture");

  cleanup();
});
