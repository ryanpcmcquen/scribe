"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { KnowledgeBase } = require("../dist/storage/index.js");
const { verifyJournal } = require("../dist/verify/index.js");
const { parseJson, runCli, tempDir } = require("./helpers");

test("verifyJournal accepts well-formed monthly knowledge and reminder files", (t) => {
  const dir = tempDir(t);
  const kb = new KnowledgeBase(dir);

  kb.appendKnowledgeEntry({
    date: "2026-11-17",
    title: "Safe knowledge entry",
    workspace: "~/code/app",
    agent: "OpenCode",
    category: "decision",
    body: "The journal uses monthly markdown files.",
  });
  kb.appendReminder({
    date: "2026-11-17",
    title: "Review release",
    priority: "p2",
    context: "The release is ready.",
    action: "Review the release notes.",
  });

  const report = verifyJournal(dir);
  assert.equal(report.ok, true);
  assert.equal(report.filesScanned, 2);
  assert.equal(report.entriesScanned, 2);
  assert.equal(report.secretFindings, 0);
  assert.equal(report.malformedFindings, 0);
  assert.deepEqual(report.issues, []);
});

test("verifyJournal detects secret-like values without returning their contents", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "knowledge", "2026-11", "2026-11-knowledge.md");
  const token = `ghp_${"Q".repeat(32)}`;
  mkdirSync(join(dir, "knowledge", "2026-11"), { recursive: true });
  writeFileSync(
    file,
    [
      "## 2026-11",
      "",
      "### 2026-11-12 — Historic token leak",
      "",
      "- **Workspace:** ~/code/app",
      "- **Agent:** OpenCode",
      "- **Category:** finding",
      "",
      `A token appeared in the old notes: ${token}`,
      "",
      "-----BEGIN RSA PRIVATE KEY-----",
      "PRIVATE_MATERIAL_SHOULD_NOT_APPEAR",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n"),
  );

  const report = verifyJournal(dir);
  assert.equal(report.ok, false);
  assert.ok(report.secretFindings >= 2);
  assert.ok(report.issues.every((issue) => !issue.message.includes(token)));
  assert.ok(
    report.issues.some(
      (issue) =>
        issue.kind === "secret" &&
        issue.path === "knowledge/2026-11/2026-11-knowledge.md",
    ),
  );
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MATERIAL/);
  assert.doesNotMatch(JSON.stringify(report), /ghp_/);
});

test("verifyJournal reports malformed headings, fields, dates, and storage paths", (t) => {
  const dir = tempDir(t);
  const monthDir = join(dir, "reminders", "2026-11");
  mkdirSync(monthDir, { recursive: true });
  writeFileSync(
    join(monthDir, "notes.md"),
    [
      "## 2026-10",
      "",
      "### 2026-13-40 — Invalid date",
      "",
      "- **Priority:** urgent",
      "- **Status:** waiting",
      "- **Snoozed Until:** tomorrow",
      "- **Context:** Missing required monthly file.",
      "",
      "An action.",
      "",
      "### 2026-11-08 — Missing priority",
      "",
      "- **Context:** This entry intentionally omits its priority.",
      "",
      "An action.",
      "",
    ].join("\n"),
  );

  const report = verifyJournal(dir);
  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some((issue) => /Expected monthly markdown file/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /Month heading does not match/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /invalid calendar date/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /Reminder priority/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /Reminder status/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /Snoozed Until/.test(issue.message)),
  );
  assert.ok(
    report.issues.some((issue) => /missing required field: Priority/.test(issue.message)),
  );
});

test("scribe verify CLI is read-only and exits nonzero when issues are found", (t) => {
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

  const clean = runCli(["verify", "--json"], { env });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(parseJson(clean).ok, true);

  const badFile = join(
    workspace,
    "knowledge",
    "2026-11",
    "2026-11-knowledge.md",
  );
  const original = readFileSync(badFile, "utf8");
  const token = `ghp_${"R".repeat(32)}`;
  writeFileSync(
    badFile,
    `${original}\n### malformed heading\n\n${token}\n`,
  );
  const beforeVerify = readFileSync(badFile, "utf8");

  const result = runCli(["verify", "--json"], { env });
  assert.equal(result.status, 1);
  const report = parseJson(result);
  assert.equal(report.ok, false);
  assert.ok(report.secretFindings > 0);
  assert.ok(report.malformedFindings > 0);
  assert.doesNotMatch(result.stdout, /ghp_/);
  assert.equal(readFileSync(badFile, "utf8"), beforeVerify);
});

test("verify reports a missing journal workspace", (t) => {
  const dir = tempDir(t);
  const result = runCli(["verify", "--workspace", join(dir, "missing"), "--json"]);
  assert.equal(result.status, 1);
  const report = parseJson(result);
  assert.equal(report.ok, false);
  assert.match(report.issues[0].message, /workspace does not exist/);
});
