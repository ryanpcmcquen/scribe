import { DEFAULT_WORKSPACE } from "./config";
import { Git } from "./git";
import {
  KnowledgeBase,
  KnowledgeEntry,
  ReminderEntry,
  ReminderStatus,
  ScribeEntry,
} from "./storage";
import {
  composeFocus,
  FocusItem,
  FocusSourceContribution,
  rankReminders,
  rankScribeEntries,
} from "./merge";
import {
  buildContextPack,
  ContextOptions,
  ContextPack,
  searchKnowledgeBase,
  SearchOptions,
  SearchResultItem,
} from "./search";

export interface ScribeOptions {
  workspacePath?: string;
  repoPath?: string;
  remote?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
}

export interface CaptureResult {
  path: string;
  committed: boolean;
  pushed: boolean;
  deduplicated?: boolean;
  pushError?: string;
}

export interface ReminderUpdateResult {
  reminder: ReminderEntry;
  path: string;
  month: string;
  committed: boolean;
  pushed: boolean;
  pushError?: string;
}

export class Scribe {
  readonly storage: KnowledgeBase;
  readonly git: Git;

  private readonly autoCommit: boolean;
  private readonly autoPush: boolean;

  constructor(options: ScribeOptions) {
    const workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
    this.storage = new KnowledgeBase(workspacePath);
    this.git = new Git(options.repoPath ?? workspacePath, options.remote);
    this.autoCommit = options.autoCommit ?? true;
    this.autoPush = options.autoPush ?? true;
  }

  private async commitAndPush(message: string): Promise<{
    committed: boolean;
    pushed: boolean;
    pushError?: string;
  }> {
    const committed = this.autoCommit
      ? await this.git.commit(message)
      : false;

    let pushed = false;
    let pushError: string | undefined;
    if (this.autoPush && committed) {
      const result = await this.git.push();
      pushed = result.pushed;
      pushError = result.error;
    }

    return {
      committed,
      pushed,
      ...(pushError ? { pushError } : {}),
    };
  }

  /**
   * Capture an entry: write to the knowledge/reminders store, commit, push.
   */
  async record(entry: ScribeEntry): Promise<CaptureResult> {
    const isDuplicate =
      "category" in entry
        ? this.storage.hasDuplicateKnowledge(entry)
        : this.storage.hasDuplicateReminder(entry);

    if (isDuplicate) {
      return {
        path: this.pathFor(entry),
        committed: false,
        pushed: false,
        deduplicated: true,
      };
    }

    const path =
      "category" in entry
        ? this.storage.appendKnowledgeEntry(entry)
        : this.storage.appendReminder(entry);

    const gitOutcome = await this.commitAndPush(
      `Scribe: ${entry.date} — ${entry.title}`,
    );

    return {
      path,
      ...gitOutcome,
    };
  }

  /**
   * Transition a reminder's status (`done`, `snoozed`, or `pending`), commit, and push.
   */
  async updateReminderStatus(
    query: string,
    status: ReminderStatus,
    options: { month?: string; snoozedUntil?: string; completedAt?: string } = {},
  ): Promise<ReminderUpdateResult> {
    const { updated, path, month } = this.storage.updateReminderStatus(query, {
      status,
      month: options.month,
      snoozedUntil: options.snoozedUntil,
      completedAt: options.completedAt,
    });

    const commitSummary =
      status === "done"
        ? `Scribe: mark reminder done — ${updated.title}`
        : status === "snoozed"
          ? `Scribe: snooze reminder until ${updated.snoozedUntil} — ${updated.title}`
          : `Scribe: reopen reminder — ${updated.title}`;

    const gitOutcome = await this.commitAndPush(commitSummary);

    return {
      reminder: updated,
      path,
      month,
      ...gitOutcome,
    };
  }

  async completeReminder(
    query: string,
    options: { month?: string; date?: string } = {},
  ): Promise<ReminderUpdateResult> {
    return this.updateReminderStatus(query, "done", {
      month: options.month,
      completedAt: options.date,
    });
  }

  async snoozeReminder(
    query: string,
    untilDate: string,
    options: { month?: string } = {},
  ): Promise<ReminderUpdateResult> {
    return this.updateReminderStatus(query, "snoozed", {
      month: options.month,
      snoozedUntil: untilDate,
    });
  }

  async reopenReminder(
    query: string,
    options: { month?: string } = {},
  ): Promise<ReminderUpdateResult> {
    return this.updateReminderStatus(query, "pending", {
      month: options.month,
    });
  }

  /**
   * The markdown file an entry would be written to (useful for --dry-run).
   */
  pathFor(entry: ScribeEntry): string {
    return "category" in entry
      ? this.storage.knowledgeFileFor(entry.date)
      : this.storage.reminderFileFor(entry.date);
  }

  /**
   * Read accumulated knowledge entries (e.g., for Flint's focus merge).
   */
  readKnowledge(month?: string): KnowledgeEntry[] {
    return this.storage.readKnowledge(month);
  }

  readAllKnowledge(): KnowledgeEntry[] {
    return this.storage.readAllKnowledge();
  }

  readReminders(month?: string): ReminderEntry[] {
    return this.storage.readReminders(month);
  }

  readAllReminders(): ReminderEntry[] {
    return this.storage.readAllReminders();
  }

  readActiveReminders(month?: string, asOfDate?: string): ReminderEntry[] {
    return this.storage.readActiveReminders(month, asOfDate);
  }

  readAllActiveReminders(asOfDate?: string): ReminderEntry[] {
    return this.storage.readAllActiveReminders(asOfDate);
  }

  /**
   * Rank accumulated Scribe knowledge entries and active reminders for Flint's focus merge.
   */
  rank(month?: string, asOfDate?: string): FocusItem[] {
    const knowledgeItems = rankScribeEntries(this.storage.readKnowledge(month));
    const reminderItems = rankReminders(
      this.storage.readReminders(month),
      asOfDate,
    );
    return composeFocus(knowledgeItems, [
      { source: "scribe-reminders", items: reminderItems },
    ]);
  }

  rankAll(asOfDate?: string): FocusItem[] {
    const knowledgeItems = rankScribeEntries(this.storage.readAllKnowledge());
    const reminderItems = rankReminders(
      this.storage.readAllReminders(),
      asOfDate,
    );
    return composeFocus(knowledgeItems, [
      { source: "scribe-reminders", items: reminderItems },
    ]);
  }

  /**
   * Search across months over knowledge entries and reminders.
   */
  search(options: SearchOptions = {}): SearchResultItem[] {
    return searchKnowledgeBase(this.storage, options);
  }

  /**
   * Build a compact, high-signal context pack for an agent or human.
   */
  context(options: ContextOptions = {}): ContextPack {
    return buildContextPack(this.storage, options);
  }

  /**
   * Compose Scribe's ranked knowledge into Flint's focus list, merging
   * additional sources when provided.
   */
  compose(
    month: string | undefined,
    additionalSources: FocusSourceContribution[] = [],
  ): FocusItem[] {
    return composeFocus(this.rank(month), additionalSources);
  }
}
