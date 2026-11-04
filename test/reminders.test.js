"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  effectiveReminderStatus,
  isReminderActive,
} = require("../dist/storage/index.js");
const { parseJson, runCli, tempDir } = require("./helpers");

function setupJournal(t) {
  const dir = tempDir(t);
  const workspace = `${dir}/journal`;
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: workspace,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };
  runCli(["init", "--workspace", workspace, "--no-git", "--json"], { env });
  return { dir, workspace, env };
}

test("reminder lifecycle transitions done, snooze, and reopen and integrates with focus", (t) => {
  const { env } = setupJournal(t);

  runCli(
    [
      "capture",
      "--title",
      "Rotate API keys",
      "--priority",
      "p1",
      "--context",
      "Quarterly security review",
      "--action",
      "Rotate production keys.",
      "--json",
    ],
    { env },
  );

  runCli(
    [
      "capture",
      "--title",
      "Write architecture note",
      "--category",
      "decision",
      "--body",
      "Document monthly file layout.",
      "--json",
    ],
    { env },
  );

  // Active p1 reminder outranks a decision (score 4 vs 3) in focus
  const initialFocus = parseJson(runCli(["focus", "--json"], { env }));
  assert.equal(initialFocus.items.length, 2);
  assert.equal(initialFocus.items[0].kind, "reminder");
  assert.equal(initialFocus.items[0].score, 4);
  assert.match(initialFocus.items[0].entry.title, /Rotate API keys/);

  // Snooze until a future date -> excluded from focus and --pending
  const snoozed = parseJson(
    runCli(
      ["reminders", "snooze", "Rotate API keys", "--until", "2099-12-31", "--json"],
      { env },
    ),
  );
  assert.equal(snoozed.reminder.status, "snoozed");
  assert.equal(snoozed.reminder.snoozedUntil, "2099-12-31");

  const pendingWhileSnoozed = parseJson(
    runCli(["reminders", "--pending", "--json"], { env }),
  );
  assert.equal(pendingWhileSnoozed.entries.length, 0);

  const focusWhileSnoozed = parseJson(runCli(["focus", "--json"], { env }));
  assert.equal(focusWhileSnoozed.items.length, 1);
  assert.equal(focusWhileSnoozed.items[0].entry.title, "Write architecture note");

  // Reopen -> back in --pending and focus
  const reopened = parseJson(
    runCli(["reminders", "reopen", "Rotate API keys", "--json"], { env }),
  );
  assert.equal(reopened.reminder.status, undefined);

  const pendingAfterReopen = parseJson(
    runCli(["reminders", "--pending", "--json"], { env }),
  );
  assert.equal(pendingAfterReopen.entries.length, 1);

  // Mark done -> excluded from --pending and focus, included in --status done
  const done = parseJson(
    runCli(["reminders", "done", "Rotate API keys", "--json"], { env }),
  );
  assert.equal(done.reminder.status, "done");
  assert.ok(done.reminder.completedAt);

  const doneList = parseJson(
    runCli(["reminders", "--status", "done", "--json"], { env }),
  );
  assert.equal(doneList.entries.length, 1);
  assert.equal(doneList.entries[0].title, "Rotate API keys");

  const focusAfterDone = parseJson(runCli(["focus", "--json"], { env }));
  assert.equal(focusAfterDone.items.length, 1);
});

test("snoozed reminders reactivate once snoozedUntil date arrives", () => {
  const reminder = {
    date: "2026-11-01",
    title: "Follow up on PR",
    priority: "p2",
    status: "snoozed",
    snoozedUntil: "2026-11-04",
    context: "Waiting on CI",
    action: "Merge PR",
  };

  assert.equal(effectiveReminderStatus(reminder, "2026-11-03"), "snoozed");
  assert.equal(isReminderActive(reminder, "2026-11-03"), false);

  assert.equal(effectiveReminderStatus(reminder, "2026-11-04"), "pending");
  assert.equal(isReminderActive(reminder, "2026-11-04"), true);
});
