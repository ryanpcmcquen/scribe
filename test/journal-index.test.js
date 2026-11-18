"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const test = require("node:test");

const { updateJournalReadmeIndex } = require("../dist/journal-index.js");
const { KnowledgeBase } = require("../dist/storage/index.js");

test("journal README refresh preserves user sections and updates monthly counts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scribe-readme-index-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const storage = new KnowledgeBase(dir);
  storage.appendKnowledgeEntry({
    date: "2026-11-17",
    title: "First monthly note",
    workspace: "~/code/app",
    agent: "OpenCode",
    category: "decision",
    body: "A first note.",
  });
  storage.appendReminder({
    date: "2026-11-17",
    title: "Review release",
    priority: "p2",
    context: "A reminder.",
    action: "Review it.",
  });

  const readmePath = join(dir, "README.md");
  writeFileSync(
    readmePath,
    [
      "# Private Journal",
      "",
      "Keep this introduction.",
      "",
      "<!-- scribe:toc:start -->",
      "## Old contents",
      "<!-- scribe:toc:end -->",
      "",
      "## Personal notes",
      "",
      "Keep this section too.",
      "",
    ].join("\n"),
  );

  updateJournalReadmeIndex(dir, storage);
  let readme = readFileSync(readmePath, "utf8");
  assert.match(readme, /Keep this introduction/);
  assert.match(readme, /Keep this section too/);
  assert.match(readme, /\| 2026-11 \| \[Open\]\(\.\/knowledge\/2026-11\/2026-11-knowledge\.md\) \|/);
  assert.match(readme, /\| 2026-11 \| \[Open\]\(\.\/reminders\/2026-11\/2026-11-reminders\.md\) \|/);
  assert.equal((readme.match(/scribe:toc:start/g) ?? []).length, 1);

  storage.appendKnowledgeEntry({
    date: "2026-12-01",
    title: "Next month note",
    workspace: "~/code/app",
    agent: "OpenCode",
    category: "finding",
    body: "A later note.",
  });
  updateJournalReadmeIndex(dir, storage);
  readme = readFileSync(readmePath, "utf8");
  assert.match(readme, /\| 2026-12 \| \[Open\]/);
  assert.match(readme, /\| 2026-11 \| \[Open\]/);
  assert.equal((readme.match(/scribe:toc:start/g) ?? []).length, 1);
  assert.doesNotMatch(readme, /\/Users\/|\/home\/[A-Za-z0-9._-]+/);
});

test("journal README is created with relative links when absent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scribe-readme-create-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const storage = new KnowledgeBase(dir);
  storage.appendKnowledgeEntry({
    date: "2026-11-17",
    title: "Initial note",
    workspace: "~/code/app",
    agent: "OpenCode",
    category: "work-log",
    body: "Initial note body.",
  });

  updateJournalReadmeIndex(dir, storage);
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  assert.match(readme, /^# Scribe Journal/m);
  assert.match(readme, /knowledge\/2026-11\/2026-11-knowledge\.md/);
  assert.match(readme, /scribe:toc:start/);
});
