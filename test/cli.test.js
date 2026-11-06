"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { parseJson, runCli, tempDir } = require("./helpers");

const hasGit =
  spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function localMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function initWorkspace(t, args = []) {
  const dir = tempDir(t);
  const env = { SCRIBE_CONFIG: `${dir}/config.json` };
  const workspace = `${dir}/journal`;

  const init = runCli(
    ["init", "--workspace", workspace, "--json", ...args],
    { env },
  );
  assert.equal(init.status, 0, init.stderr);

  return { dir, env, workspace };
}

test("init creates config, month files, and a git repository", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { env, workspace } = initWorkspace(t);

  assert.ok(existsSync(`${workspace}/.git`));
  assert.ok(existsSync(`${workspace}/.gitignore`));

  const month = localMonth();
  const knowledgeFiles = readdirSync(`${workspace}/knowledge`);
  assert.ok(knowledgeFiles.includes(month));
  assert.ok(
    readFileSync(
      `${workspace}/knowledge/${month}/${month}-knowledge.md`,
      "utf8",
    ).startsWith(`## ${month}`),
  );

  const config = parseJson(
    runCli(["config", "--json"], { env }),
  );
  assert.equal(config.config.workspace, workspace);
});

test("capture writes, commits, and reads back knowledge", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { dir, env } = initWorkspace(t);

  const capture = runCli(
    [
      "capture",
      "--title",
      "Use monthly files",
      "--category",
      "decision",
      "--body",
      "Keep diffs small.",
      "--repo",
      `${dir}/app`,
      "--agent",
      "OpenCode",
      "--json",
    ],
    { env },
  );
  assert.equal(capture.status, 0, capture.stderr);
  const captured = parseJson(capture);
  assert.equal(captured.ok, true);
  assert.equal(captured.entry.title, "Use monthly files");
  assert.equal(captured.committed, true);
  assert.equal(captured.pushed, false);
  assert.ok(existsSync(captured.path));

  const read = parseJson(runCli(["read", "--json"], { env }));
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].title, "Use monthly files");
  assert.equal(read.entries[0].category, "decision");
  assert.equal(read.entries[0].body, "Keep diffs small.");

  const focus = parseJson(runCli(["focus", "--json"], { env }));
  assert.equal(focus.items[0].entry.title, "Use monthly files");
  assert.equal(focus.items[0].score, 3);
});

test("capture --no-commit leaves changes uncommitted", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { env, workspace } = initWorkspace(t);

  const capture = runCli(
    ["capture", "--title", "Local only", "--no-commit", "--no-push", "--json"],
    { env },
  );
  assert.equal(capture.status, 0, capture.stderr);
  assert.equal(parseJson(capture).committed, false);

  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.match(status.stdout, /knowledge\//);
});

test("capture --dry-run validates without writing", (t) => {
  const { env, workspace } = initWorkspace(t, ["--no-git"]);
  const month = localMonth();
  const file = `${workspace}/knowledge/${month}/${month}-knowledge.md`;
  const before = readFileSync(file, "utf8");

  const result = runCli(
    ["capture", "--title", "Dry run", "--body", "Not written", "--dry-run", "--json"],
    { env },
  );
  assert.equal(result.status, 0, result.stderr);

  const output = parseJson(result);
  assert.equal(output.dryRun, true);
  assert.equal(output.path, file);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("capture --stdin accepts JSON and flags override it", (t) => {
  const { env } = initWorkspace(t, ["--no-git"]);

  const result = runCli(
    [
      "capture",
      "--stdin",
      "--no-commit",
      "--no-push",
      "--title",
      "Flag title wins",
      "--json",
    ],
    {
      env,
      input: JSON.stringify({
        type: "reminder",
        title: "Stdin title",
        priority: "p1",
        context: "Captured from an agent.",
        action: "Review it.",
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const captured = parseJson(result);
  assert.equal(captured.entry.title, "Flag title wins");
  assert.equal(captured.entry.priority, "p1");

  const reminders = parseJson(runCli(["reminders", "--json"], { env }));
  assert.equal(reminders.entries.length, 1);
  assert.equal(reminders.entries[0].title, "Flag title wins");
});

test("created knowledge appears in read --all across months", (t) => {
  const { env } = initWorkspace(t, ["--no-git"]);

  for (const [date, title] of [
    ["2026-10-31", "October"],
    ["2026-11-01", "November"],
  ]) {
    const result = runCli(
      [
        "capture",
        "--date",
        date,
        "--title",
        title,
        "--no-commit",
        "--no-push",
        "--json",
      ],
      { env },
    );
    assert.equal(result.status, 0, result.stderr);
  }

  const all = parseJson(runCli(["read", "--all", "--json"], { env }));
  assert.equal(all.month, null);
  assert.deepEqual(
    all.entries.map((entry) => entry.title),
    ["October", "November"],
  );
});

test("capture pushes to a configured remote path", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { dir, env } = initWorkspace(t);
  const bare = `${dir}/remote.git`;

  const initBare = spawnSync("git", ["init", "--bare", "-b", "main", bare], {
    encoding: "utf8",
  });
  assert.equal(initBare.status, 0, initBare.stderr);

  const capture = runCli(
    ["capture", "--title", "Pushed entry", "--json"],
    { env: { ...env, SCRIBE_REMOTE: bare } },
  );
  assert.equal(capture.status, 0, capture.stderr);

  const output = parseJson(capture);
  assert.equal(output.committed, true);
  assert.equal(output.pushed, true);
  assert.equal(output.pushError, undefined);

  const remoteLog = spawnSync(
    "git",
    ["--git-dir", bare, "log", "--oneline", "main"],
    { encoding: "utf8" },
  );
  assert.match(remoteLog.stdout, /Scribe: .* Pushed entry/);
});

test("capture auto-rebases on non-fast-forward push and scribe sync pulls remote commits", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { dir, env, workspace: workspaceA } = initWorkspace(t);
  const bare = `${dir}/remote.git`;
  const workspaceB = `${dir}/journal-b`;
  const envA = { ...env, SCRIBE_REMOTE: bare };
  const envB = {
    SCRIBE_CONFIG: `${dir}/config-b.json`,
    SCRIBE_WORKSPACE: workspaceB,
    SCRIBE_REMOTE: bare,
  };

  const initBare = spawnSync("git", ["init", "--bare", "-b", "main", bare], {
    encoding: "utf8",
  });
  assert.equal(initBare.status, 0, initBare.stderr);

  const firstPush = runCli(
    ["capture", "--date", "2026-10-15", "--title", "Initial commit from A", "--json"],
    { env: envA },
  );
  assert.equal(firstPush.status, 0, firstPush.stderr);
  assert.equal(parseJson(firstPush).pushed, true);

  const cloneB = spawnSync("git", ["clone", bare, workspaceB], {
    encoding: "utf8",
  });
  assert.equal(cloneB.status, 0, cloneB.stderr);

  const secondFromA = runCli(
    ["capture", "--date", "2026-10-16", "--title", "Ahead commit from A", "--json"],
    { env: envA },
  );
  assert.equal(secondFromA.status, 0, secondFromA.stderr);
  assert.equal(parseJson(secondFromA).pushed, true);

  const concurrentFromB = runCli(
    ["capture", "--date", "2026-11-01", "--title", "Concurrent commit from B", "--json"],
    { env: envB },
  );
  assert.equal(concurrentFromB.status, 0, concurrentFromB.stderr);
  const outB = parseJson(concurrentFromB);
  assert.equal(outB.committed, true);
  assert.equal(outB.pushed, true);
  assert.equal(outB.rebased, true);

  const syncA = runCli(["sync", "--json"], { env: envA });
  assert.equal(syncA.status, 0, syncA.stderr);
  const syncOut = parseJson(syncA);
  assert.equal(syncOut.ok, true);
  assert.equal(syncOut.pulled, true);
  assert.equal(syncOut.rebased, true);

  const allOnA = parseJson(runCli(["read", "--all", "--json"], { env: envA }));
  assert.deepEqual(
    allOnA.entries.map((entry) => entry.title),
    [
      "Initial commit from A",
      "Ahead commit from A",
      "Concurrent commit from B",
    ],
  );
});

test("doctor treats a configured remote path as configured", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { dir, env } = initWorkspace(t);

  const result = runCli(["doctor", "--json"], {
    env: { ...env, SCRIBE_REMOTE: `${dir}/remote.git` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseJson(result).warnings, []);
});

test("doctor passes for a git workspace without a remote", (t) => {
  if (!hasGit) return t.skip("git is not installed");
  const { env } = initWorkspace(t);

  const result = runCli(["doctor", "--json"], { env });
  assert.equal(result.status, 0, result.stderr);

  const doctor = parseJson(result);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.gitRepo, true);
  assert.deepEqual(doctor.errors, []);
  assert.ok(doctor.warnings.some((warning) => /no git remote/.test(warning)));
});

test("doctor fails when the workspace is not a git repository", (t) => {
  const { env } = initWorkspace(t, ["--no-git"]);

  const result = runCli(["doctor", "--json"], { env });
  assert.equal(result.status, 1);

  const doctor = parseJson(result);
  assert.equal(doctor.ok, false);
  assert.ok(doctor.errors.some((error) => /not a git repository/.test(error)));
});

test("invalid capture input fails with a JSON error", (t) => {
  const { env } = initWorkspace(t, ["--no-git"]);

  for (const args of [
    ["capture", "--title", "", "--json"],
    ["capture", "--title", "Bad date", "--date", "2026-13-01", "--json"],
    ["capture", "--title", "Bad category", "--category", "nope", "--json"],
  ]) {
    const result = runCli(args, { env });
    assert.equal(result.status, 1);
    assert.equal(parseJson(result).ok, false);
  }

  const invalidJson = runCli(
    ["capture", "--stdin", "--json"],
    { env, input: "{not json" },
  );
  assert.equal(invalidJson.status, 1);
  assert.match(parseJson(invalidJson).error, /invalid JSON/);
});

test("unknown commands fail with a JSON error", (t) => {
  const { env } = initWorkspace(t, ["--no-git"]);
  const result = runCli(["nope", "--json"], { env });
  assert.equal(result.status, 1);
  assert.match(parseJson(result).error, /unknown command/);
});
