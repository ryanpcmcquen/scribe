"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  KnowledgeBase,
  redactHomePaths,
  redactSecrets,
} = require("../dist/storage/index.js");
const { Scribe } = require("../dist/scribe.js");
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

test("redactHomePaths scrubs home directory references across entry fields", (t) => {
  const fakeHome = "/tmp/fake-home-alice";
  assert.equal(
    redactHomePaths(
      "Checked /tmp/fake-home-alice/code/app and /tmp/fake-home-alice.",
      fakeHome,
    ),
    "Checked ~/code/app and ~.",
  );

  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);
  const realHome = require("node:os").homedir();
  kb.appendKnowledgeEntry({
    date: "2026-11-04",
    title: `Inspect ${realHome}/code/scribe`,
    workspace: `${realHome}/code/scribe`,
    agent: "OpenCode",
    category: "finding",
    body: `Found config under ${realHome}/.config/scribe/config.json.`,
  });

  const [entry] = kb.readKnowledge("2026-11");
  assert.equal(entry.title, "Inspect ~/code/scribe");
  assert.equal(entry.workspace, "~/code/scribe");
  assert.equal(entry.body, "Found config under ~/.config/scribe/config.json.");
});

test("redactSecrets scrubs credentials and private keys across entry fields", (t) => {
  const ghToken = `ghp_${"A".repeat(28)}`;
  const skToken = `sk-proj-${"B".repeat(24)}`;
  const awsKey = `AKIA${"C".repeat(16)}`;
  const slackToken = `xoxb-${"1".repeat(12)}-${"a".repeat(12)}`;
  const bearer = `Bearer ${"Z".repeat(24)}`;
  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBALfakekeydata==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  const raw = `gh=${ghToken} api=${skToken} aws=${awsKey} slack=${slackToken} auth=${bearer}\n${privateKey}`;
  const scrubbed = redactSecrets(raw);

  assert.doesNotMatch(scrubbed, /ghp_/);
  assert.doesNotMatch(scrubbed, /sk-proj-/);
  assert.doesNotMatch(scrubbed, /AKIA/);
  assert.doesNotMatch(scrubbed, /xoxb-/);
  assert.doesNotMatch(scrubbed, /MIIBOg/);
  assert.match(scrubbed, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_API_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_AWS_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_SLACK_TOKEN\]/);
  assert.match(scrubbed, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_PRIVATE_KEY\]/);

  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);
  kb.appendKnowledgeEntry({
    date: "2026-11-09",
    title: `Rotated token ${ghToken}`,
    workspace: "~/code/scribe",
    agent: "OpenCode",
    category: "finding",
    body: `Replaced ${skToken} in config.`,
  });

  const [saved] = kb.readKnowledge("2026-11");
  assert.equal(saved.title, "Rotated token [REDACTED_GITHUB_TOKEN]");
  assert.equal(saved.body, "Replaced [REDACTED_API_KEY] in config.");
});

test("Scribe.record deduplicates identical entries on the same date", async (t) => {
  const dir = tempDir(t);
  const scribe = new Scribe({
    workspacePath: dir,
    autoCommit: false,
    autoPush: false,
  });

  const entry = {
    date: "2026-11-04",
    title: "Idempotent capture",
    workspace: "~/code/scribe",
    agent: "OpenCode",
    category: "decision",
    body: "Deduplicate identical retries.",
  };

  const first = await scribe.record(entry);
  assert.equal(first.deduplicated, undefined);

  const second = await scribe.record(entry);
  assert.equal(second.deduplicated, true);
  assert.equal(second.committed, false);
  assert.equal(scribe.readKnowledge("2026-11").length, 1);
});
