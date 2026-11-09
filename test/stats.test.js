"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseJson, runCli, tempDir } = require("./helpers");

test("scribe stats summarizes knowledge entries and reminders across months and workspaces", (t) => {
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
      "2026-10-20",
      "--title",
      "October decision",
      "--category",
      "decision",
      "--repo",
      `${dir}/scribe`,
      "--agent",
      "OpenCode",
      "--body",
      "Decided on monthly files.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--date",
      "2026-11-05",
      "--title",
      "November finding",
      "--category",
      "finding",
      "--repo",
      `${dir}/flint`,
      "--agent",
      "Claude Code",
      "--body",
      "Found focus merge point.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--date",
      "2026-11-06",
      "--title",
      "Check release notes",
      "--priority",
      "p1",
      "--context",
      "Release 0.2.0",
      "--action",
      "Verify changelog.",
      "--json",
    ],
    { env },
  );

  const allStats = parseJson(runCli(["stats", "--all", "--json"], { env }));
  assert.equal(allStats.ok, true);
  assert.equal(allStats.knowledge.total, 2);
  assert.equal(allStats.knowledge.byCategory.decision, 1);
  assert.equal(allStats.knowledge.byCategory.finding, 1);
  assert.equal(allStats.knowledge.byWorkspace.length, 2);
  assert.equal(allStats.reminders.total, 1);
  assert.equal(allStats.reminders.pending, 1);
  assert.equal(allStats.reminders.byPriority.p1, 1);
  assert.match(allStats.markdown, /## Scribe Stats \(all months\)/);

  const filteredStats = parseJson(
    runCli(
      ["stats", "--month", "2026-11", "--repo", `${dir}/flint`, "--json"],
      { env },
    ),
  );
  assert.equal(filteredStats.knowledge.total, 1);
  assert.equal(filteredStats.knowledge.byCategory.finding, 1);

  const markdownCli = runCli(["stats", "--all"], { env });
  assert.equal(markdownCli.status, 0, markdownCli.stderr);
  assert.match(markdownCli.stdout, /Knowledge entries:\*\* 2/);
});
