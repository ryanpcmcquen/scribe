"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { KnowledgeBase } = require("../dist/storage/index.js");
const { tempDir } = require("./helpers");

test("knowledge entries round-trip through monthly files", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);

  const path = kb.appendKnowledgeEntry({
    date: "2026-11-04",
    title: "Monthly storage",
    workspace: "~/code/app",
    agent: "OpenCode",
    category: "decision",
    body: "Split storage by month.\n\nKeeps diffs small.",
  });

  assert.equal(path, `${dir}/knowledge/2026-11/2026-11-knowledge.md`);
  assert.match(
    readFileSync(path, "utf8"),
    /^## 2026-11\n\n### 2026-11-04 — Monthly storage/,
  );

  assert.deepEqual(kb.readKnowledge("2026-11"), [
    {
      date: "2026-11-04",
      title: "Monthly storage",
      workspace: "~/code/app",
      agent: "OpenCode",
      category: "decision",
      body: "Split storage by month.\n\nKeeps diffs small.",
    },
  ]);
});

test("multiple entries append and read back in order", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);

  kb.appendKnowledgeEntry({
    date: "2026-11-03",
    title: "First",
    workspace: "~/a",
    agent: "Codex",
    category: "finding",
    body: "one",
  });
  kb.appendKnowledgeEntry({
    date: "2026-11-04",
    title: "Second",
    workspace: "~/b",
    agent: "Cline",
    category: "work-log",
    body: "two",
  });

  const entries = kb.readKnowledge("2026-11");
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ["First", "Second"],
  );
});

test("reminders round-trip through monthly files", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);

  const path = kb.appendReminder({
    date: "2026-11-04",
    title: "Implement reminder lifecycle",
    priority: "p1",
    context: "Only reading exists today.",
    action: "Add pending/done/snooze.",
  });

  assert.equal(path, `${dir}/reminders/2026-11/2026-11-reminders.md`);
  assert.deepEqual(kb.readReminders("2026-11"), [
    {
      date: "2026-11-04",
      title: "Implement reminder lifecycle",
      priority: "p1",
      context: "Only reading exists today.",
      action: "Add pending/done/snooze.",
    },
  ]);
});

test("readAll and listMonths span every month", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);

  kb.appendKnowledgeEntry({
    date: "2026-10-31",
    title: "October",
    workspace: "~/app",
    agent: "OpenCode",
    category: "finding",
    body: "",
  });
  kb.appendKnowledgeEntry({
    date: "2026-11-01",
    title: "November",
    workspace: "~/app",
    agent: "OpenCode",
    category: "finding",
    body: "",
  });
  kb.appendReminder({
    date: "2026-11-02",
    title: "November reminder",
    priority: "p2",
    context: "",
    action: "",
  });

  assert.deepEqual(kb.listMonths("knowledge"), ["2026-10", "2026-11"]);
  assert.deepEqual(kb.listMonths("reminders"), ["2026-11"]);
  assert.deepEqual(
    kb.readAllKnowledge().map((entry) => entry.title),
    ["October", "November"],
  );
  assert.deepEqual(
    kb.readAllReminders().map((entry) => entry.title),
    ["November reminder"],
  );
});

test("missing months read as empty arrays", (t) => {
  const kb = new KnowledgeBase(tempDir(t));
  assert.deepEqual(kb.readKnowledge("1999-01"), []);
  assert.deepEqual(kb.readReminders("1999-01"), []);
  assert.deepEqual(kb.readAllKnowledge(), []);
  assert.deepEqual(kb.readAllReminders(), []);
  assert.deepEqual(kb.listMonths("knowledge"), []);
});
