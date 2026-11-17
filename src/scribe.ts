import { DEFAULT_WORKSPACE } from "./config";
import { Git, SyncResult } from "./git";
import { withWorkspaceLock } from "./lock";
import {
  KnowledgeBase,
  KnowledgeEntry,
  ReminderEntry,
  ReminderStatus,
  ScribeEntry,
} from "./storage";
import {
  composeFocus,
  composeFocusFromInput,
  ComposeFocusInput,
  ComposeFocusOptions,
  FocusItem,
  FocusSourceContribution,
  formatFocusBullets,
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
import { computeStats, ScribeStats, StatsOptions } from "./stats";
import { verifyJournal, VerifyOptions, VerifyReport } from "./verify";
import {
  buildLocalCatalog,
  CatalogBuildResult,
  CatalogRecord,
  searchCatalog,
  updateLocalCatalogIfPresent,
} from "./catalog";

export interface ScribeOptions {
  workspacePath?: string;
  repoPath?: string;
  remote?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
  redactionLiterals?: string[];
}

export interface CaptureResult {
  path: string;
  committed: boolean;
  pushed: boolean;
  rebased?: boolean;
  deduplicated?: boolean;
  pushError?: string;
}

export interface ReminderUpdateResult {
  reminder: ReminderEntry;
  path: string;
  month: string;
  committed: boolean;
  pushed: boolean;
  rebased?: boolean;
  pushError?: string;
}

export interface BatchCaptureResult {
  input: number;
  created: number;
  deduplicated: number;
  paths: string[];
  committed: boolean;
  pushed: boolean;
  pushError?: string;
}

export class Scribe {
  readonly storage: KnowledgeBase;
  readonly git: Git;

  private readonly workspacePath: string;
  private readonly redactionLiterals: string[];
  private readonly autoCommit: boolean;
  private readonly autoPush: boolean;

  constructor(options: ScribeOptions) {
    const workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
    this.workspacePath = workspacePath;
    this.redactionLiterals = options.redactionLiterals ?? [];
    this.storage = new KnowledgeBase(workspacePath, this.redactionLiterals);
    this.git = new Git(options.repoPath ?? workspacePath, options.remote);
    this.autoCommit = options.autoCommit ?? true;
    this.autoPush = options.autoPush ?? true;
  }

  private async commitAndPush(message: string): Promise<{
    committed: boolean;
    pushed: boolean;
    rebased?: boolean;
    pushError?: string;
  }> {
    const committed = this.autoCommit
      ? await this.git.commit(message)
      : false;

    let pushed = false;
    let rebased: boolean | undefined;
    let pushError: string | undefined;
    if (this.autoPush && committed) {
      const result = await this.git.push();
      pushed = result.pushed;
      rebased = result.rebased;
      pushError = result.error;
    }

    return {
      committed,
      pushed,
      ...(rebased ? { rebased: true } : {}),
      ...(pushError ? { pushError } : {}),
    };
  }

  /**
   * Synchronize the journal repository with its configured remote: commit
   * uncommitted local changes, pull with rebase/autostash, and push.
   */
  async sync(commitMessage?: string): Promise<SyncResult> {
    return withWorkspaceLock(this.workspacePath, () =>
      this.git.sync({
        commitMessage,
        autoCommit: this.autoCommit,
        autoPush: this.autoPush,
      }),
    );
  }

  private async recordUnlocked(entry: ScribeEntry): Promise<CaptureResult> {
    const sanitizedEntry =
      "category" in entry
        ? this.storage.sanitizeKnowledgeEntry(entry)
        : this.storage.sanitizeReminderEntry(entry);
    const isDuplicate =
      "category" in sanitizedEntry
        ? this.storage.hasDuplicateKnowledge(sanitizedEntry)
        : this.storage.hasDuplicateReminder(sanitizedEntry);

    if (isDuplicate) {
      return {
        path: this.pathFor(sanitizedEntry),
        committed: false,
        pushed: false,
        deduplicated: true,
      };
    }

    const path =
      "category" in sanitizedEntry
        ? this.storage.appendKnowledgeEntry(sanitizedEntry)
        : this.storage.appendReminder(sanitizedEntry);

    const gitOutcome = await this.commitAndPush(
      `Scribe: ${sanitizedEntry.date} — ${sanitizedEntry.title}`,
    );

    try {
      updateLocalCatalogIfPresent(
        this.storage,
        this.workspacePath,
        this.redactionLiterals,
      );
    } catch {}

    return {
      path,
      ...gitOutcome,
    };
  }

  /**
   * Capture an entry: write to the knowledge/reminders store, commit, push.
   */
  async record(entry: ScribeEntry): Promise<CaptureResult> {
    return withWorkspaceLock(this.workspacePath, () =>
      this.recordUnlocked(entry),
    );
  }

  async recordBatch(entries: KnowledgeEntry[]): Promise<BatchCaptureResult> {
    return withWorkspaceLock(this.workspacePath, async () => {
      const paths: string[] = [];
      let created = 0;
      let deduplicated = 0;

      for (const entry of entries) {
        const sanitized = this.storage.sanitizeKnowledgeEntry(entry);
        if (this.storage.hasDuplicateKnowledge(sanitized)) {
          deduplicated++;
          continue;
        }
        paths.push(this.storage.appendKnowledgeEntry(sanitized));
        created++;
      }

      const gitOutcome =
        created > 0
          ? await this.commitAndPush(
              `Scribe: import ${created} knowledge entries`,
            )
          : { committed: false, pushed: false };

      if (created > 0) {
        try {
          updateLocalCatalogIfPresent(
            this.storage,
            this.workspacePath,
            this.redactionLiterals,
          );
        } catch {}
      }

      return {
        input: entries.length,
        created,
        deduplicated,
        paths,
        ...gitOutcome,
      };
    });
  }

  /**
   * Transition a reminder's status (`done`, `snoozed`, or `pending`), commit, and push.
   */
  async updateReminderStatus(
    query: string,
    status: ReminderStatus,
    options: { month?: string; snoozedUntil?: string; completedAt?: string } = {},
  ): Promise<ReminderUpdateResult> {
    return withWorkspaceLock(this.workspacePath, () =>
      this.updateReminderStatusUnlocked(query, status, options),
    );
  }

  private async updateReminderStatusUnlocked(
    query: string,
    status: ReminderStatus,
    options: { month?: string; snoozedUntil?: string; completedAt?: string },
  ): Promise<ReminderUpdateResult> {
    const { updated, path, month } = this.storage.updateReminderStatus(query, {
      status,
      month: options.month,
      snoozedUntil: options.snoozedUntil,
      completedAt: options.completedAt,
    });
    const sanitizedReminder = this.storage.sanitizeReminderEntry(updated);

    const commitSummary =
      status === "done"
        ? `Scribe: mark reminder done — ${sanitizedReminder.title}`
        : status === "snoozed"
          ? `Scribe: snooze reminder until ${sanitizedReminder.snoozedUntil} — ${sanitizedReminder.title}`
          : `Scribe: reopen reminder — ${sanitizedReminder.title}`;

    const gitOutcome = await this.commitAndPush(commitSummary);

    return {
      reminder: sanitizedReminder,
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
    const knowledgeItems = rankScribeEntries(
      this.storage.readKnowledge(month),
      asOfDate,
    );
    const reminderItems = rankReminders(
      this.storage.readReminders(month),
      asOfDate,
    );
    return composeFocus(knowledgeItems, [
      { source: "scribe-reminders", items: reminderItems },
    ]);
  }

  rankAll(asOfDate?: string): FocusItem[] {
    const knowledgeItems = rankScribeEntries(
      this.storage.readAllKnowledge(),
      asOfDate,
    );
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
   * Compute summary statistics across knowledge entries and reminders.
   */
  stats(options: StatsOptions = {}): ScribeStats {
    return computeStats(this.storage, options);
  }

  /**
   * Read-only audit of journal structure and likely secret values.
   */
  verify(options: Omit<VerifyOptions, "redactionLiterals"> = {}): VerifyReport {
    return verifyJournal(this.workspacePath, {
      ...options,
      redactionLiterals: this.redactionLiterals,
    });
  }

  buildCatalog(options: { force?: boolean } = {}): CatalogBuildResult {
    return buildLocalCatalog(
      this.storage,
      this.workspacePath,
      this.redactionLiterals,
      options,
    );
  }

  searchCatalog(query: string, limit = 10): CatalogRecord[] {
    const catalog = this.buildCatalog();
    return searchCatalog(catalog.records, query, limit);
  }

  /**
   * Compose Scribe's ranked knowledge into Flint's focus list, merging
   * additional sources when provided.
   */
  compose(
    month: string | undefined,
    additionalSources: FocusSourceContribution[] = [],
    options: ComposeFocusOptions = {},
  ): FocusItem[] {
    return composeFocus(this.rank(month, options.asOfDate), additionalSources, options);
  }

  /**
   * Compose Scribe's ranked entries with external git/session/MCP candidates.
   */
  composeBrief(
    input: ComposeFocusInput = {},
    options: ComposeFocusOptions & { month?: string; all?: boolean } = {},
  ): { items: FocusItem[]; bullets: string } {
    const base = options.all
      ? this.rankAll(options.asOfDate)
      : this.rank(options.month, options.asOfDate);
    const items = composeFocusFromInput(base, input, options);
    return {
      items,
      bullets: formatFocusBullets(items),
    };
  }
}
