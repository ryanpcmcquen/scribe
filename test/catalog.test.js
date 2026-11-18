"use strict";

const assert = require("node:assert/strict");
const { existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { buildLocalCatalog, deriveAutomaticTags, extractiveSummary } =
  require("../dist/catalog/index.js");
const { KnowledgeBase } = require("../dist/storage/index.js");
const { Scribe } = require("../dist/scribe.js");
const { parseJson, runCli, tempDir } = require("./helpers");

test("catalog summaries and keywords are generated locally and deterministically", () => {
  const body = [
    "## Storage",
    "",
    "Git rebase handles concurrent journal updates and remote sync.",
    "",
    "A second paragraph is not used in the short extractive summary.",
  ].join("\n");

  assert.equal(
    extractiveSummary(body),
    "Git rebase handles concurrent journal updates and remote sync.",
  );
  assert.deepEqual(
    deriveAutomaticTags("Journal sync", body),
    deriveAutomaticTags("Journal sync", body),
  );
  assert.ok(deriveAutomaticTags("Journal sync", body).includes("journal"));
});

test("catalog builds locally, reuses unchanged months, and refreshes changed months", async (t) => {
  const dir = tempDir(t);
  const workspace = join(dir, "journal");
  const kb = new KnowledgeBase(workspace);
  kb.appendKnowledgeEntry({
    date: "2026-11-17",
    title: "Rebase journal sync",
    workspace: "~/code/scribe",
    agent: "OpenCode",
    category: "decision",
    body: "Git rebase handles concurrent journal updates.",
  });

  const first = buildLocalCatalog(kb, workspace);
  t.after(() => rmSync(first.path, { force: true }));
  assert.equal(first.total, 1);
  assert.deepEqual(first.updatedMonths, ["2026-11"]);
  assert.deepEqual(first.reusedMonths, []);
  assert.ok(existsSync(first.path));
  assert.equal(first.records[0].path, "knowledge/2026-11/2026-11-knowledge.md");
  assert.ok(first.records[0].tags.includes("journal"));
  assert.match(first.records[0].summary, /Git rebase handles concurrent/);
  assert.equal(first.path.startsWith(workspace), false);

  const second = buildLocalCatalog(kb, workspace);
  assert.deepEqual(second.updatedMonths, []);
  assert.deepEqual(second.reusedMonths, ["2026-11"]);

  kb.appendKnowledgeEntry({
    date: "2026-11-18",
    title: "Context retrieval",
    workspace: "~/code/scribe",
    agent: "OpenCode",
    category: "finding",
    body: "Search should retrieve only context-relevant notes.",
  });
  const third = buildLocalCatalog(kb, workspace);
  assert.equal(third.total, 2);
  assert.deepEqual(third.updatedMonths, ["2026-11"]);
  assert.deepEqual(third.reusedMonths, []);

  const scribe = new Scribe({
    workspacePath: workspace,
    autoCommit: false,
    autoPush: false,
  });
  await scribe.record({
    date: "2026-11-19",
    title: "Incremental catalog update",
    workspace: "~/code/scribe",
    agent: "OpenCode",
    category: "finding",
    body: "A capture updates an already-built local catalog.",
  });
  const fourth = buildLocalCatalog(kb, workspace);
  assert.equal(fourth.total, 3);
  assert.deepEqual(fourth.updatedMonths, []);
  assert.deepEqual(fourth.reusedMonths, ["2026-11"]);
});

test("catalog build and search CLI return compact metadata without AI calls", (t) => {
  const dir = tempDir(t);
  const workspace = join(dir, "journal");
  const env = {
    SCRIBE_CONFIG: join(dir, "config.json"),
    SCRIBE_WORKSPACE: workspace,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };

  const init = runCli(
    ["init", "--workspace", workspace, "--no-git", "--json"],
    { env },
  );
  assert.equal(init.status, 0, init.stderr);

  for (const [title, body] of [
    ["Rebase sync decision", "Git rebase handles concurrent journal updates."],
    ["Markdown entry parser", "The parser preserves nested markdown headings."],
    ["Long sync notes", `${"sync ".repeat(50)} unrelated details.`],
  ]) {
    const capture = runCli(
      [
        "capture",
        "--title",
        title,
        "--category",
        "finding",
        "--body",
        body,
        "--no-commit",
        "--no-push",
        "--json",
      ],
      { env },
    );
    assert.equal(capture.status, 0, capture.stderr);
  }

  const build = runCli(["catalog", "build", "--json"], { env });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(parseJson(build).total, 3);
  assert.equal(parseJson(build).aiCalls, 0);

  const search = runCli(
    ["catalog", "search", "rebase sync", "--limit", "1", "--json"],
    { env },
  );
  assert.equal(search.status, 0, search.stderr);
  const result = parseJson(search);
  assert.equal(result.aiCalls, 0);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, "Rebase sync decision");
  assert.ok(result.results[0].summary);
  assert.ok(result.results[0].tags.length > 0);
  assert.equal("body" in result.results[0], false);
});
