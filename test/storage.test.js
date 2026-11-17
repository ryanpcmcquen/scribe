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
  const googleKey = `AIza${"D".repeat(35)}`;
  const gitlabToken = `glpat-${"E".repeat(24)}`;
  const npmToken = `npm_${"F".repeat(36)}`;
  const pypiToken = `pypi-${"G".repeat(50)}`;
  const stripeKey = `rk_live_${"H".repeat(24)}`;
  const stripeSecretKey = `sk_live_${"O".repeat(24)}`;
  const jwt = `${"eyJ".concat("I".repeat(12))}.${"J".repeat(14)}.${"K".repeat(14)}`;
  const slackWebhook = `https://hooks.slack.com/services/${"A".repeat(10)}/${"B".repeat(10)}/${"C".repeat(24)}`;
  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBALfakekeydata==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  const raw = [
    `gh=${ghToken}`,
    `api=${skToken}`,
    `aws=${awsKey}`,
    `slack=${slackToken}`,
    `auth=${bearer}`,
    `google=${googleKey}`,
    `gitlab=${gitlabToken}`,
    `npm=${npmToken}`,
    `pypi=${pypiToken}`,
    `stripe=${stripeKey}`,
    `stripe_secret=${stripeSecretKey}`,
    `jwt=${jwt}`,
    `webhook=${slackWebhook}`,
    `auth_token=${"P".repeat(20)}`,
    `api_key="${"L".repeat(20)}"`,
    `password=${"M".repeat(20)}`,
    `url=https://user:${"N".repeat(20)}@example.test/path`,
    privateKey,
  ].join("\n");
  const scrubbed = redactSecrets(raw);

  assert.doesNotMatch(scrubbed, /ghp_/);
  assert.doesNotMatch(scrubbed, /sk-proj-/);
  assert.doesNotMatch(scrubbed, /AKIA/);
  assert.doesNotMatch(scrubbed, /xoxb-/);
  assert.doesNotMatch(scrubbed, /AIza/);
  assert.doesNotMatch(scrubbed, /glpat-/);
  assert.doesNotMatch(scrubbed, /npm_/);
  assert.doesNotMatch(scrubbed, /pypi-/);
  assert.doesNotMatch(scrubbed, /rk_live_/);
  assert.doesNotMatch(scrubbed, /sk_live_/);
  assert.doesNotMatch(scrubbed, /eyJ/);
  assert.doesNotMatch(scrubbed, /hooks\.slack\.com/);
  assert.doesNotMatch(scrubbed, /MIIBOg/);
  assert.match(scrubbed, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_API_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_AWS_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_SLACK_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_GOOGLE_API_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_GITLAB_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_NPM_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_PYPI_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_STRIPE_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_JWT\]/);
  assert.match(scrubbed, /\[REDACTED_SLACK_WEBHOOK\]/);
  assert.match(scrubbed, /\[REDACTED_CREDENTIAL\]/);
  assert.match(scrubbed, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_PRIVATE_KEY\]/);
  assert.equal(
    redactSecrets("This sentence contains no credentials and token=short."),
    "This sentence contains no credentials and token=short.",
  );

  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);
  kb.appendKnowledgeEntry({
    date: "2026-11-09",
    title: `Rotated token ${ghToken}`,
    workspace: "~/code/scribe",
    agent: `OpenCode ${awsKey}`,
    category: "finding",
    body: `Replaced ${skToken} in config.`,
  });

  const [saved] = kb.readKnowledge("2026-11");
  assert.equal(saved.title, "Rotated token [REDACTED_GITHUB_TOKEN]");
  assert.equal(saved.agent, "OpenCode [REDACTED_AWS_KEY]");
  assert.equal(saved.body, "Replaced [REDACTED_API_KEY] in config.");

  kb.appendReminder({
    date: "2026-11-09",
    title: "Rotate credentials",
    priority: "p1",
    context: `Found ${gitlabToken} in the deployment notes.`,
    action: `Replace ${googleKey} and ${npmToken}.`,
  });
  const [reminder] = kb.readReminders("2026-11");
  assert.equal(
    reminder.context,
    "Found [REDACTED_GITLAB_TOKEN] in the deployment notes.",
  );
  assert.equal(
    reminder.action,
    "Replace [REDACTED_GOOGLE_API_KEY] and [REDACTED_NPM_TOKEN].",
  );
});

test("custom redaction literals apply to knowledge and reminder fields", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir, ["ORG_PRIVATE_VALUE"]);

  kb.appendKnowledgeEntry({
    date: "2026-11-17",
    title: "Investigate ORG_PRIVATE_VALUE",
    workspace: "~/code/ORG_PRIVATE_VALUE",
    agent: "OpenCode",
    category: "finding",
    body: "Found ORG_PRIVATE_VALUE in a configuration example.",
  });
  kb.appendReminder({
    date: "2026-11-17",
    title: "Rotate ORG_PRIVATE_VALUE",
    priority: "p1",
    context: "A private value was captured.",
    action: "Replace ORG_PRIVATE_VALUE.",
  });

  const [knowledge] = kb.readKnowledge("2026-11");
  const [reminder] = kb.readReminders("2026-11");
  assert.equal(knowledge.title, "Investigate [REDACTED_CUSTOM]");
  assert.equal(knowledge.workspace, "~/code/[REDACTED_CUSTOM]");
  assert.equal(knowledge.body, "Found [REDACTED_CUSTOM] in a configuration example.");
  assert.equal(reminder.title, "Rotate [REDACTED_CUSTOM]");
  assert.equal(reminder.action, "Replace [REDACTED_CUSTOM].");
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
