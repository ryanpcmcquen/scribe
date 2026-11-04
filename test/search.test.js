"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseJson, runCli, tempDir } = require("./helpers");

test("scribe search ranks cross-month results and filters by workspace and category", (t) => {
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
      "2026-10-15",
      "--title",
      "SQLite WAL concurrency finding",
      "--category",
      "finding",
      "--repo",
      `${dir}/db-service`,
      "--body",
      "Enable busy_timeout alongside WAL mode.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--date",
      "2026-11-03",
      "--title",
      "Split storage by month",
      "--category",
      "decision",
      "--repo",
      `${dir}/scribe`,
      "--body",
      "Per-month files keep context small and greppable.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--date",
      "2026-11-04",
      "--title",
      "Add Flint focus integration",
      "--priority",
      "p1",
      "--context",
      "Morning brief merge",
      "--action",
      "Consume scribe focus --all --json in Flint.",
      "--json",
    ],
    { env },
  );

  const octSearch = parseJson(
    runCli(["search", "WAL concurrency", "--json"], { env }),
  );
  assert.equal(octSearch.count, 1);
  assert.equal(octSearch.results[0].title, "SQLite WAL concurrency finding");

  const repoFiltered = parseJson(
    runCli(["search", "--repo", `${dir}/scribe`, "--json"], { env }),
  );
  assert.equal(repoFiltered.count, 1);
  assert.equal(repoFiltered.results[0].title, "Split storage by month");

  const reminderSearch = parseJson(
    runCli(["search", "Flint focus", "--kind", "reminders", "--json"], { env }),
  );
  assert.equal(reminderSearch.count, 1);
  assert.equal(reminderSearch.results[0].kind, "reminder");

  const contextPack = parseJson(
    runCli(["context", "--repo", `${dir}/scribe`, "--json"], { env }),
  );
  assert.equal(contextPack.ok, true);
  assert.equal(contextPack.decisions.length, 1);
  assert.equal(contextPack.decisions[0].title, "Split storage by month");
  assert.equal(contextPack.activeReminders.length, 1);
  assert.match(contextPack.markdown, /### Pending Reminders/);
  assert.match(contextPack.markdown, /### Key Decisions/);
});
