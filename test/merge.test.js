"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { recencyDecay } = require("../dist/merge/index.js");
const { parseJson, runCli, tempDir } = require("./helpers");

test("scribe focus merges git, mcp, session, and scribe sources with precedence and bullet output", (t) => {
  const dir = tempDir(t);
  const workspace = `${dir}/journal`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: workspace,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };

  runCli(["init", "--workspace", workspace, "--no-git", "--json"], { env });

  runCli(
    [
      "capture",
      "--title",
      "Use monthly files",
      "--category",
      "decision",
      "--repo",
      `${dir}/scribe`,
      "--body",
      "Keep diffs small.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--title",
      "Verify push auth",
      "--priority",
      "p1",
      "--context",
      "Remote configured",
      "--action",
      "Test git push.",
      "--json",
    ],
    { env },
  );

  const stdinSources = JSON.stringify({
    git: [
      {
        title: "Finish uncommitted changes on main",
        workspace: `${dir}/flint`,
        uncommitted: true,
      },
    ],
    mcp: [
      {
        title: "Reply to release thread in Slack",
        workspace: "slack",
        priority: "p1",
      },
    ],
    sessions: [
      {
        title: "Pick up: Resume Scribe session",
        workspace: `${dir}/scribe`,
      },
      // Duplicate title+workspace should be deduplicated
      {
        title: "Use monthly files",
        workspace: `${dir}/scribe`,
      },
    ],
  });

  const merged = parseJson(
    runCli(["focus", "--stdin", "--limit", "4", "--json"], {
      env,
      input: stdinSources,
    }),
  );

  assert.equal(merged.ok, true);
  assert.equal(merged.items.length, 4);
  // Git uncommitted (5) ranks first, followed by p1 reminder / p1 MCP (4), then decision/session (3)
  assert.equal(merged.items[0].source, "git");
  assert.equal(merged.items[0].score, 5);
  assert.equal(merged.bullets.length, 4);
  assert.match(merged.bullets[0], /^- flint: Finish uncommitted changes on main$/);

  const bulletCli = runCli(["focus", "--stdin", "--bullets", "--limit", "2"], {
    env,
    input: stdinSources,
  });
  assert.equal(bulletCli.status, 0, bulletCli.stderr);
  assert.match(bulletCli.stdout, /^- flint: Finish uncommitted changes on main\n/m);
});

test("recencyDecay and scribe focus apply age-based score decay while keeping reminders steady", (t) => {
  assert.equal(recencyDecay("2026-11-25", "2026-11-25"), 0);
  assert.equal(recencyDecay("2026-11-23", "2026-11-25"), 0.25);
  assert.equal(recencyDecay("2026-11-19", "2026-11-25"), 0.5);
  assert.equal(recencyDecay("2026-11-13", "2026-11-25"), 1.0);
  assert.equal(recencyDecay("2026-11-01", "2026-11-25"), 1.25);
  assert.equal(recencyDecay("2026-10-01", "2026-11-25"), 1.5);

  const dir = tempDir(t);
  const workspace = `${dir}/journal`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: workspace,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };

  runCli(["init", "--workspace", workspace, "--no-git", "--json"], { env });

  runCli(
    [
      "capture",
      "--date",
      "2026-11-01",
      "--title",
      "Stale early-month decision",
      "--category",
      "decision",
      "--repo",
      `${dir}/scribe`,
      "--body",
      "Older decision.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--date",
      "2026-11-25",
      "--title",
      "Fresh today finding",
      "--category",
      "finding",
      "--repo",
      `${dir}/scribe`,
      "--body",
      "New finding today.",
      "--json",
    ],
    { env },
  );

  const focus = parseJson(
    runCli(["focus", "--month", "2026-11", "--date", "2026-11-25", "--json"], {
      env,
    }),
  );
  assert.equal(focus.ok, true);
  assert.equal(focus.items.length, 2);
  assert.equal(focus.items[0].entry.title, "Fresh today finding");
  assert.equal(focus.items[0].score, 2);
  assert.equal(focus.items[1].entry.title, "Stale early-month decision");
  assert.equal(focus.items[1].score, 1.75);
});
